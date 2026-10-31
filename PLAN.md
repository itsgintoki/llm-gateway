# Project Specification: Minimal Production LLM Gateway (`llm-gateway`)

## 1. Role & Execution Rules for the Coding Agent
You are building a high-reliability, minimal LLM Gateway in Node.js and TypeScript.
- **Strict Incremental Execution:** Execute one Phase at a time. Run `pnpm typecheck` and `pnpm test` after each phase before moving to the next.
- **No Over-Engineering:** Do NOT build a frontend UI, user registration/login flows, streaming SSE, or Redis dependencies. Keep the infrastructure strictly to **Node.js + Express + PostgreSQL (Drizzle ORM)**.
- **Financial & Concurrency Correctness:** All monetary values MUST be stored and computed in **integer micro-USD** (`1 USD = 1,000,000 micro-USD`) using `bigint` in Postgres and `number`/`bigint` in TypeScript to avoid IEEE 754 floating-point drift.
- **Zero-Trust Concurrency:** Enforce per-key budgets using **Two-Phase Pessimistic Reservation** (`SELECT ... FOR UPDATE` in Postgres) so concurrent requests on a near-exhausted key cannot double-spend (TOCTOU prevention). Never hold a database transaction open while waiting for an external LLM HTTP call.

---

## 2. Tech Stack & Directory Structure
- **Runtime & Language:** Node.js (v20+), TypeScript (strict mode)
- **Package Manager:** `pnpm`
- **Framework:** Express (`express`, `cors`, `helmet`)
- **Validation:** `zod`
- **Database & ORM:** PostgreSQL (`pg`) + Drizzle ORM (`drizzle-orm`, `drizzle-kit`)
- **Testing:** `vitest`, `supertest`

```text
llm-gateway/
├── src/
│   ├── config/
│   │   ├── env.ts            # Zod-validated environment variables
│   │   └── pricing.ts        # Static model pricing table (micro-USD per 1M tokens)
│   ├── db/
│   │   ├── index.ts          # pg Pool + Drizzle instance
│   │   └── schema.ts         # virtual_keys and usage_logs tables
│   └── seed.ts               # CLI script to seed test virtual keys
│   ├── services/
│   │   ├── budget.service.ts # Two-phase reserve(), settle(), and release() logic
│   │   └── llm.service.ts    # Primary + Fallback provider clients with AbortSignal timeout
│   ├── routes/
│   │   ├── chat.route.ts     # POST /v1/chat/completions
│   │   └── usage.route.ts    # GET /v1/usage
│   ├── utils/
│   │   └── crypto.ts         # SHA-256 key hashing helper
│   ├── app.ts                # Express app setup & global error handler
│   └── server.ts             # HTTP server entry point
├── tests/
│   └── gateway.test.ts       # Integration & concurrency race-condition tests
├── DECISIONS.md
├── AI-LOG.md
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

---

## 3. Database Schema (`src/db/schema.ts`)

### Table 1: `virtual_keys`

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | `uuid` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Internal key ID |
| `key_hash` | `text` | `NOT NULL UNIQUE` | SHA-256 hex digest of raw `rok_...` bearer key |
| `key_prefix` | `text` | `NOT NULL` | First 10 chars (e.g. `rok_live_1`) for safe display |
| `name` | `text` | `NOT NULL` | Human-readable label (e.g. `team-alpha-prod`) |
| `budget_limit_micro_usd` | `bigint` | `NOT NULL` (mode: `'number'`) | Total cap in micro-USD (`1_000_000` = $1.00) |
| `spent_micro_usd` | `bigint` | `NOT NULL DEFAULT 0` | Confirmed settled spend in micro-USD |
| `reserved_micro_usd` | `bigint` | `NOT NULL DEFAULT 0` | In-flight worst-case reserved spend |
| `is_active` | `boolean` | `NOT NULL DEFAULT true` | Kill switch for the key |
| `created_at` | `timestamp` | `NOT NULL DEFAULT now()` | Creation timestamp |

### Table 2: `usage_logs`

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | `uuid` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Log ID |
| `key_id` | `uuid` | `NOT NULL REFERENCES virtual_keys(id)` | Foreign key to virtual key |
| `requested_model` | `text` | `NOT NULL` | Model requested by client |
| `actual_model` | `text` | `NOT NULL` | Model actually executed (primary or fallback) |
| `provider_used` | `text` | `NOT NULL` | `groq` or `gemini-fallback` |
| `fallback_triggered` | `boolean` | `NOT NULL DEFAULT false` | True if primary provider failed/timed out |
| `fallback_reason` | `text` | `NULL` | Error code/timeout reason from primary |
| `prompt_tokens` | `integer` | `NOT NULL` | Input tokens reported by provider |
| `completion_tokens` | `integer` | `NOT NULL` | Output tokens reported by provider |
| `cost_micro_usd` | `bigint` | `NOT NULL` (mode: `'number'`) | Final calculated cost in micro-USD |
| `latency_ms` | `integer` | `NOT NULL` | End-to-end provider call duration |
| `status_code` | `integer` | `NOT NULL` | HTTP status returned to caller |
| `created_at` | `timestamp` | `NOT NULL DEFAULT now()` | Request timestamp |

---

## 4. Core Business Logic Specifications

### A. Pricing & Worst-Case Cost Estimation (`src/config/pricing.ts`)

1. Define a pricing map in **micro-USD per 1,000,000 tokens** (which simplifies to **micro-USD per token** when divided by `1_000_000`, or use `Math.ceil((tokens * pricePerMillionMicroUsd) / 1_000_000)`):
- `llama-3.3-70b-versatile` (Groq Primary): Input = `$0.59 / 1M` (`590_000` micro-USD/1M), Output = `$0.79 / 1M` (`790_000` micro-USD/1M).
- `gemini-2.5-flash` (Gemini OpenAI-compatible Fallback): Input = `$0.15 / 1M` (`150_000` micro-USD/1M), Output = `$0.60 / 1M` (`600_000` micro-USD/1M).

2. **Pre-Flight Estimation Formula:**
- Estimate input tokens conservatively: `Math.ceil(JSON.stringify(messages).length / 3) + 20`.
- Enforce a default `max_tokens` cap if omitted by caller: `const maxTokens = req.max_tokens ?? 512` (hard cap at `4096`).
- Compute `reservedMicroUsd` using the **higher** price between primary and fallback for `(estimatedInputTokens * inputRate) + (maxTokens * outputRate)`, minimum `1` micro-USD.

### B. Two-Phase Budget Reservation (`src/services/budget.service.ts`)

1. **`authenticateAndReserve(rawKey: string, estimatedCostMicroUsd: number)`**:
- Hash `rawKey` with SHA-256.
- Start a short PostgreSQL transaction (`db.transaction`).
- Execute `SELECT * FROM virtual_keys WHERE key_hash = $1 FOR UPDATE`.
- If not found or `!is_active`, throw `401 Unauthorized`.
- Check `spent_micro_usd + reserved_micro_usd + estimatedCostMicroUsd > budget_limit_micro_usd`.
- If exceeded, rollback and throw `402 Payment Required` (or `429 Too Many Requests`) with JSON body:
```json
{
  "error": {
    "code": "budget_exceeded",
    "message": "Key budget exhausted or insufficient available balance for worst-case request cost.",
    "budget_limit_micro_usd": 100000,
    "spent_micro_usd": 95000,
    "reserved_micro_usd": 4000,
    "required_reservation_micro_usd": 2500
  }
}
```
- Otherwise, execute `UPDATE virtual_keys SET reserved_micro_usd = reserved_micro_usd + $1 WHERE id = $2` and commit the transaction immediately.

2. **`settleReservation(keyId, reservedMicroUsd, actualCostMicroUsd, logEntry)`**:
- In a single transaction:
- `UPDATE virtual_keys SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $reserved), spent_micro_usd = spent_micro_usd + $actual WHERE id = $keyId`.
- `INSERT INTO usage_logs (...) VALUES (...)`.

3. **`releaseReservation(keyId, reservedMicroUsd)`** (Called in `catch` block if both primary and fallback providers fail):
- `UPDATE virtual_keys SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $reserved) WHERE id = $keyId`.

### C. Provider Proxy & Resilience Policy (`src/services/llm.service.ts`)

1. Both Groq (`https://api.groq.com/openai/v1/chat/completions`) and Gemini (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`) support the OpenAI Chat Completions REST specification via standard `fetch`.
2. **Execution Policy:**
- **Step 1 (Primary Attempt):** Send request to Primary Provider (Groq) with `AbortSignal.timeout(8000)`.
- **Step 2 (Transient Retry):** If Primary returns HTTP `429`, `500`, `502`, `503`, `504`, or network/timeout error, wait `250ms` and retry Primary **once**. (Do **NOT** retry or fallback on `400 Bad Request` / `422` validation errors—release reservation and fail fast).
- **Step 3 (Fallback Provider):** If the retry fails, route the request to Fallback Provider (Gemini OpenAI-compatible endpoint, or a deterministic local/mock fallback if `FALLBACK_MODE=mock` is set) with `AbortSignal.timeout(10000)`.
- Return normalized OpenAI response JSON plus gateway metadata fields (`x_gateway: { provider_used, fallback_triggered, cost_micro_usd, latency_ms }`).

---

## 5. API Endpoints Specification

### 1. `POST /v1/chat/completions`

- **Auth:** `Authorization: Bearer rok_...`
- **Request Body (Zod Validated):**
- `model`: `z.string().default('llama-3.3-70b-versatile')`
- `messages`: `z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().min(1) })).min(1)`
- `max_tokens`: `z.number().int().min(1).max(4096).optional().default(512)`
- `temperature`: `z.number().min(0).max(2).optional().default(0.7)`
- `stream`: `z.literal(false).optional().default(false)` (Explicitly reject `stream: true` with `400` and clear message explaining non-streaming deterministic accounting).
- **Header Injection:** For testing resilience in production/curl, support an optional header `x-simulate-primary-failure: true` that forces the primary provider to throw a simulated `503` so reviewers can verify fallback behavior on demand.

### 2. `GET /v1/usage`

- **Auth:** Accepts `Authorization: Bearer rok_...` OR query param `?key=rok_...` (as requested in prompt spec).
- **Response (`200 OK`):**
```json
{
  "key_name": "demo-standard-key",
  "key_prefix": "rok_live_a",
  "budget_limit_micro_usd": 500000,
  "spent_micro_usd": 1420,
  "reserved_micro_usd": 0,
  "remaining_micro_usd": 498580,
  "spend_usd_formatted": "$0.001420",
  "total_requests": 3,
  "fallback_count": 1,
  "recent_logs": [...]
}
```

### 3. `GET /health`

- Simple `SELECT 1` DB check returning `{ status: "ok", timestamp }`.

---

## 6. Step-by-Step Build Phases for Agent

### Phase 1: Project Initialization & Database Layer

1. Initialize `package.json`, `tsconfig.json`, `.env.example`, and `.gitignore`.
2. Install dependencies: `express`, `cors`, `helmet`, `zod`, `pg`, `drizzle-orm`, `dotenv` and devDependencies: `typescript`, `@types/node`, `@types/express`, `@types/cors`, `@types/pg`, `drizzle-kit`, `tsx`, `vitest`, `supertest`, `@types/supertest`.
3. Create `src/config/env.ts` and `src/db/schema.ts`.
4. Generate/push schema using `drizzle-kit push` and implement `src/db/seed.ts` to create 3 deterministic test keys and print their raw values to console:
- **Key 1 (`rok_test_rich_...`)**: `$1.00` (`1_000_000` micro-USD) budget for normal and fallback testing.
- **Key 2 (`rok_test_tight_...`)**: `$0.0015` (`1_500` micro-USD) budget for testing concurrent race conditions (`Promise.all`) where one request succeeds and the simultaneous second request gets blocked by `reserved_micro_usd`.
- **Key 3 (`rok_test_empty_...`)**: `$0.00` (`0` micro-USD) budget for immediate `402` rejection testing.

### Phase 2: Budget Service & Provider Fallback Engine

1. Implement `src/config/pricing.ts` and `src/services/budget.service.ts` with `authenticateAndReserve`, `settleReservation`, and `releaseReservation`.
2. Implement `src/services/llm.service.ts` with Groq primary, Gemini fallback, `AbortSignal.timeout`, 1 retry on transient error, and support for `x-simulate-primary-failure: true`.

### Phase 3: Express Routes & Error Handling

1. Implement `POST /v1/chat/completions`, `GET /v1/usage`, and `GET /health`.
2. Wire global error handling middleware so Zod errors return `400`, auth errors return `401`, budget errors return `402`, and upstream failures return `502`.

### Phase 4: Integration & Concurrency Verification (`tests/gateway.test.ts`)

Write automated Vitest + Supertest tests covering:

1. **Auth Check:** Missing/invalid virtual key returns `401`.
2. **Budget Exhaustion:** Calling with `rok_test_empty_...` returns `402` and logs `0` provider calls.
3. **TOCTOU Concurrency Proof:** Fire 3 simultaneous requests using `Promise.all` against `rok_test_tight_...` (which only has enough budget for 1 request). Assert that **exactly 1** succeeds (`200`) and **2** are rejected (`402`), proving `SELECT ... FOR UPDATE` + `reserved_micro_usd` prevented double-spending.
4. **Fallback Trigger:** Pass `x-simulate-primary-failure: true` and assert `200 OK` with `x_gateway.fallback_triggered === true` and `provider_used === 'gemini-fallback'`.
5. **Spend Accounting:** Call `GET /v1/usage` and assert `spent_micro_usd > 0` and `reserved_micro_usd === 0`.

### Phase 5: Deliverables (`DECISIONS.md`, `AI-LOG.md`, `README.md`)

Draft crisp, first-principles markdown files directly addressing every bullet in the take-home prompt:

- `DECISIONS.md`: Request lifecycle ASCII diagram, 4 core architectural tradeoffs (Non-streaming vs Streaming, Micro-USD integer cost budgeting vs token caps, Two-Phase Pessimistic Reservation vs Naive Read-After-Write, Sync vs Async usage logging), why enforce budgets at gateway vs caller, fallback policy defense, deliberate scope cuts, least confident decision (heuristic pre-flight input token estimation vs running `tiktoken` in-process), and where the system breaks at 10k RPS (Postgres row lock contention on hot keys -> migrating reservations to Redis Lua scripts + async Kafka/BullMQ log flushing).
- `AI-LOG.md`: Honest breakdown of using Antigravity/LLMs for scaffolding, where the AI was overridden (e.g., preventing the AI from holding a DB transaction open across the external `fetch` call, or fixing float arithmetic to integer micro-USD), and how security/budget invariants were verified via concurrency tests.
