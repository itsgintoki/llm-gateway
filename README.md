# Minimal Production LLM Gateway (`llm-gateway`)

A high-reliability, minimal LLM Gateway built with **Node.js, TypeScript, Express, PostgreSQL, and Drizzle ORM**.

Engineered from first principles with **zero-trust concurrency protection (TOCTOU prevention)** via **Two-Phase Pessimistic Reservation**, integer micro-USD financial correctness, and automatic provider fallback.

---

## Key Architectural Highlights

* **Two-Phase Pessimistic Reservation:** Prevents double-spending (TOCTOU race conditions) under high concurrency using PostgreSQL row locks (`SELECT ... FOR UPDATE`).
* **Zero Transaction Leakage:** Row locks are held exclusively for sub-3ms reservation updates. **Database transactions are NEVER held open while awaiting external LLM HTTP calls.**
* **Integer Micro-USD Financial Precision:** Eliminates IEEE 754 floating-point rounding drift by storing and computing all monetary amounts in integer micro-USD (`1 USD = 1,000,000 µUSD`) using PostgreSQL `bigint`.
* **Resilient Provider Proxy & Fallback:**
  * **Primary Provider:** Groq (`qwen/qwen3.8-27b`) with 8,000ms timeout.
  * **Transient Retry:** 1 automatic retry with 250ms backoff on `429`, `5xx`, or timeout. Non-transient `400`/`422` client errors fail fast.
  * **Fallback Provider:** Gemini (`gemini-3.1-flash-lite`) via OpenAI-compatible endpoint with 10,000ms timeout.
  * **Circuit Breaker:** Automatically trips to `OPEN` after repeated consecutive primary failures, fast-routing subsequent requests to fallback without paying the 8s timeout penalty.
* **Orphaned Reservation Sweeper:** Reclaims in-flight reservations stranded if the server suffers an ungraceful crash (`SIGKILL`, OOM) via tracked expiration TTL.
* **Client Disconnect Propagation:** Immediately aborts upstream LLM calls and refunds reservations if the client closes the connection before completion.
* **Deterministic Resilience Testing:** Supports `x-simulate-primary-failure: true` header to test provider fallback mechanics on demand.
* **No Over-Engineering:** Pure Node.js + Express + PostgreSQL stack without Redis dependencies, frontends, or streaming overhead.

---

## Prerequisites & Tech Stack

* **Node.js:** v20+ (v22+ recommended)
* **Package Manager:** `pnpm`
* **Database:** PostgreSQL (v15+ or v16)
* **ORM:** Drizzle ORM
* **Testing:** Vitest + Supertest

---

## Quick Start

### 1. Clone & Install Dependencies
```bash
cd llm-gateway
pnpm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Ensure `DATABASE_URL` points to your PostgreSQL instance:
```env
PORT=3001
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/llm_gateway
GROQ_API_KEY=gsk_your_groq_api_key_here
GEMINI_API_KEY=AIzaSy_your_gemini_api_key_here
FALLBACK_MODE=live
```

> **Note on Testing & Mock Mode:** If you do not have live Groq/Gemini API keys, set `FALLBACK_MODE=mock`. The test suite and server will use high-fidelity, deterministic simulated responses with 50ms simulated network latency.

### 3. Push Schema & Seed Test Keys
```bash
# Push database schema to PostgreSQL
pnpm db:push

# Seed deterministic test keys
pnpm db:seed
```

The seed script creates 3 deterministic test virtual keys:
1. `rok_test_rich_1000000_abc123` ($1.00 / 1,000,000 µUSD) — standard and fallback testing.
2. `rok_test_tight_0001500_def456` ($0.0015 / 1,500 µUSD) — concurrency race testing (`Promise.all`).
3. `rok_test_empty_0000000_ghi789` ($0.00 / 0 µUSD) — immediate 402 budget rejection testing.

### 4. Run Automated Verification Tests
```bash
# Run all integration and TOCTOU concurrency race tests
pnpm test

# Run strict TypeScript typechecking
pnpm typecheck
```

### 5. Start the Server
```bash
# Development mode with auto-reload
pnpm dev

# Or production build & start
pnpm build
pnpm start
```

---

## Quick Verification & Usage via `curl`

Once the server is running on port 3001 (`http://localhost:3001`), run the following commands:

### 1. Health Check
```bash
curl -s http://localhost:3001/health | jq .
```
**Expected Response (`200 OK`):**
```json
{
  "status": "ok",
  "timestamp": "2026-10-31T10:00:00.000Z"
}
```

---

### 2. Standard Chat Completion (`200 OK`)
Sends a request using the rich test key:
```bash
curl -s -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer rok_test_rich_1000000_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "system", "content": "You are a concise assistant." },
      { "role": "user", "content": "What is the speed of light?" }
    ],
    "max_tokens": 128
  }' | jq .
```
**Expected Response:** Standard OpenAI response containing `x_gateway` metadata:
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "qwen/qwen3.8-27b",
  "choices": [ ... ],
  "usage": { "prompt_tokens": 28, "completion_tokens": 24, "total_tokens": 52 },
  "x_gateway": {
    "provider_used": "groq",
    "fallback_triggered": false,
    "cost_micro_usd": 35,
    "latency_ms": 65
  }
}
```

---

### 3. Immediate Budget Exhaustion (`402 Payment Required`)
Sends a request using the empty test key ($0.00 budget):
```bash
curl -s -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer rok_test_empty_0000000_ghi789" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Hello world" }]
  }' | jq .
```
**Expected Response (`402 Payment Required`):**
```json
{
  "error": {
    "code": "budget_exceeded",
    "message": "Key budget exhausted or insufficient available balance for worst-case request cost.",
    "budget_limit_micro_usd": 0,
    "spent_micro_usd": 0,
    "reserved_micro_usd": 0,
    "required_reservation_micro_usd": 418
  }
}
```

---

### 4. Live Provider Fallback Verification (`200 OK` via Gemini)
Passes the chaos header `-H "x-simulate-primary-failure: true"`:
```bash
curl -s -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer rok_test_rich_1000000_abc123" \
  -H "x-simulate-primary-failure: true" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Simulate primary outage" }],
    "max_tokens": 64
  }' | jq .
```
**Expected Response:** Successfully falls back to `gemini-fallback`:
```json
{
  "id": "chatcmpl-...",
  "model": "gemini-3.1-flash-lite",
  "choices": [ ... ],
  "x_gateway": {
    "provider_used": "gemini-fallback",
    "fallback_triggered": true,
    "cost_micro_usd": 15,
    "latency_ms": 312
  }
}
```

---

### 5. Inspect Spend & Usage Statistics
Retrieve live usage and audit logs via query param or Authorization header:
```bash
curl -s "http://localhost:3001/v1/usage?key=rok_test_rich_1000000_abc123" | jq .
```
**Expected Response (`200 OK`):**
```json
{
  "key_name": "test-rich-standard",
  "key_prefix": "rok_test_r",
  "budget_limit_micro_usd": 1000000,
  "spent_micro_usd": 50,
  "reserved_micro_usd": 0,
  "remaining_micro_usd": 999950,
  "spend_usd_formatted": "$0.000050",
  "total_requests": 2,
  "fallback_count": 1,
  "recent_logs": [ ... ]
}
```

---

## Directory Structure

```text
llm-gateway/
├── src/
│   ├── config/
│   │   ├── env.ts            # Zod-validated environment configuration
│   │   └── pricing.ts        # Model pricing table & integer micro-USD estimation
│   ├── db/
│   │   ├── index.ts          # pg Pool + Drizzle ORM instance
│   │   ├── schema.ts         # virtual_keys and usage_logs schema definitions
│   │   └── seed.ts           # Deterministic test keys seed script
│   ├── services/
│   │   ├── budget.service.ts # Two-phase pessimistic reservation, settlement, and rollback
│   │   └── llm.service.ts    # Groq primary, retry logic, and Gemini fallback engine
│   ├── routes/
│   │   ├── chat.route.ts     # POST /v1/chat/completions
│   │   └── usage.route.ts    # GET /v1/usage
│   ├── utils/
│   │   └── crypto.ts         # SHA-256 key hashing utility
│   ├── app.ts                # Express setup, middleware, and global error handling
│   └── server.ts             # HTTP server entry point with graceful teardown
├── tests/
│   └── gateway.test.ts       # Automated integration, fallback, and TOCTOU concurrency tests
├── DECISIONS.md              # In-depth architectural tradeoffs, diagrams, and scaling analysis
├── drizzle.config.ts         # Drizzle configuration
├── package.json
├── tsconfig.json             # Typecheck (src + tests)
└── tsconfig.build.json       # Production build (src only)
```
