# Architectural & Engineering Decisions (`DECISIONS.md`)

## 1. What We Built
We built a production-grade, non-streaming HTTP LLM Gateway in Node.js, TypeScript, and PostgreSQL (via Drizzle ORM) that sits between client applications and upstream LLM providers (Groq primary, Gemini Flash fallback). It enforces zero-trust virtual API keys (`rok_...`), prevents concurrent budget overruns via two-phase pessimistic reservations in integer micro-USD, logs deterministic per-request token and cost telemetry, and automatically recovers from upstream timeouts or 5xx/429 failures.

---

## 2. Moving Parts & Request Lifecycle

```text
[Client]
   │  POST /v1/chat/completions (Bearer rok_...)
   ▼
[1. Zod Validation & Pre-Flight Cost Estimator]
   │  Validates schema, rejects stream:true, computes worst-case cost in micro-USD
   ▼
[2. PostgreSQL: Two-Phase Pessimistic Reservation (Short Tx)]
   │  SELECT ... FOR UPDATE on virtual_keys (by SHA-256 key_hash)
   │  Checks: spent + reserved + worst_case <= budget_limit
   │  Increments reserved_micro_usd & COMMITS immediately (never holds lock over HTTP)
   ▼
[3. Resilient LLM Router (AbortSignal Timeouts)]
   ├─► Primary (Groq: llama-3.3-70b-versatile, 8s timeout)
   │     └─► On 429/5xx/Timeout: Wait 250ms jittered backoff -> Retry Primary Once
   └─► Fallback (Gemini: gemini-2.5-flash, 10s timeout)
         └─► Triggered if Primary retry fails (400 Bad Request fails fast without fallback)
   ▼
[4. PostgreSQL: Atomic Settlement & Audit Log (Short Tx)]
   │  Success: Decrements reserved_micro_usd, increments spent_micro_usd by actual cost,
   │           inserts immutable row into usage_logs.
   │  Total Failure: Releases reserved_micro_usd so caller isn't charged for 502s.
   ▼
[Client] ◄── Returns OpenAI-compatible JSON + x_gateway telemetry metadata
```

---

## 3. Core Architectural Decisions & Tradeoffs

### Decision 1: Non-Streaming over Streaming Responses

* **Options Considered:** (A) Server-Sent Events (SSE) streaming proxy, (B) Non-streaming synchronous JSON proxy.
* **Choice:** Non-streaming (`stream: false` enforced at validation).
* **Tradeoff Accepted:** Higher time-to-first-token (TTFT) perceived by end users in exchange for strict financial and accounting determinism. In streaming pipelines, upstream providers frequently omit token usage until the final SSE chunk, and mid-stream TCP disconnects leave the gateway guessing how many tokens were generated—requiring local BPE tokenizers (`tiktoken`) and complex reconciliation workers. Non-streaming guarantees exact provider-reported `prompt_tokens` and `completion_tokens` before settling the ledger.

### Decision 2: Cost-Based Budgeting in Integer Micro-USD (`bigint`)

* **Options Considered:** (A) Request count limits, (B) Raw token caps, (C) Floating-point USD (`numeric`/`float`), (D) Integer Micro-USD (`1 USD = 1,000,000 micro-USD`).
* **Choice:** Integer Micro-USD (`bigint` in Postgres).
* **Tradeoff Accepted:** Requires maintaining an internal pricing lookup table (`pricing.ts`) rather than naive counter increments. However, request counts and raw token caps fail in multi-model gateways because 1,000 output tokens on a frontier model cost orders of magnitude more than 1,000 input tokens on a flash model. Using integer micro-USD completely eliminates IEEE 754 floating-point precision drift during thousands of small fractional additions.

### Decision 3: Synchronous Settlement over Async Fire-and-Forget Logging

* **Options Considered:** (A) Push usage logs to an in-memory queue/background worker after responding, (B) Settle budget and insert the `usage_logs` row synchronously inside a fast DB transaction before returning the HTTP response.
* **Choice:** Synchronous settlement before returning.
* **Tradeoff Accepted:** Adds ~4–8ms of Postgres commit latency to the tail of an 800ms LLM call, but guarantees zero data loss on container restarts (e.g., Render/Railway SIGTERM) and ensures that an immediate subsequent call to `GET /v1/usage` reflects 100% read-after-write consistency.

### Decision 4: Partial OpenAI Schema Compatibility + Gateway Telemetry Envelope

* **Options Considered:** (A) Custom bespoke JSON schema, (B) Full pass-through of every vendor-specific OpenAI parameter, (C) Core OpenAI subset (`model`, `messages`, `max_tokens`, `temperature`) with an appended `x_gateway` metadata block.
* **Choice:** Option C.
* **Tradeoff Accepted:** Advanced tool-calling or logprobs fields are stripped by Zod, but standard OpenAI SDKs work out-of-the-box while callers also gain transparency into `provider_used`, `fallback_triggered`, and `cost_micro_usd`.

---

## 4. First-Principles: Why Enforce Budgets at the Gateway Instead of Trusting Callers?

Client applications are fundamentally untrusted execution environments regarding cost control. Even when callers are internal microservices written by well-intentioned engineers, a single bug—such as an infinite retry loop, an unescaped recursive agent loop, or a prompt injection that forces maximum token generation—can drain an organization's shared upstream provider credit in minutes. Furthermore, callers do not have global visibility into cross-service spend or live model pricing changes. Centralizing budget enforcement at the gateway establishes a single, choke-point circuit breaker where identity, rate/spend invariants, and secret isolation are enforced before a packet ever reaches an external billing API.

---

## 5. Concurrency: Handling Simultaneous Requests on a Near-Exhausted Key

**What happens if two requests hit a key with $0.0015 remaining at the exact same millisecond?**
In a naive `SELECT spent -> call LLM -> UPDATE spent` architecture, both requests read `$0.0015` available, both call the upstream LLM (taking 1–3 seconds), and both increment spend—resulting in a classic Time-of-Check to Time-of-Use (TOCTOU) double-spend.

**How we solved it:** We implemented **Two-Phase Pessimistic Reservation**:

1. **Phase 1 (Pre-Flight Lock & Reserve):** Inside a short transaction, we execute `SELECT ... FROM virtual_keys WHERE key_hash = $1 FOR UPDATE`. This acquires a row-level lock on that specific key. We compute the worst-case cost (`estimated_input_tokens * input_rate + max_tokens * output_rate`) and verify `spent_micro_usd + reserved_micro_usd + worst_case <= budget_limit_micro_usd`. We increment `reserved_micro_usd` and **immediately commit** the transaction so the row lock is held for <5ms (never across the external network I/O).
2. **Concurrent Request Behavior:** The second simultaneous request unblocks from `FOR UPDATE` milliseconds later, sees the updated `reserved_micro_usd`, fails the budget invariant check, and is cleanly rejected with `402 Payment Required` before touching the upstream LLM.
3. **Phase 2 (Post-Flight Settle/Release):** Once the LLM responds, a second short transaction atomically deducts the reservation (`reserved_micro_usd - worst_case`) and adds the true cost (`spent_micro_usd + actual_cost`). If both providers fail, `releaseReservation()` frees the reserved balance.

---

## 6. Fallback Policy & Defense

* **Policy:**
1. Call Primary (`Groq`) with an `8,000ms` hard timeout (`AbortSignal.timeout`).
2. If Primary fails with a transient error (`429 Rate Limit`, `500/502/503/504`, or timeout), wait `250ms` (with jitter) and retry Primary **once**.
3. If the retry fails, fail over immediately to Secondary (`Gemini 2.5 Flash` OpenAI-compatible endpoint) with a `10,000ms` timeout.
4. If Primary returns a `400 Bad Request` or `422`, **do not retry and do not fallback**—release the budget reservation and fail fast.

* **Defense:** Retrying a `400` wastes latency on a malformed payload. Retrying once on `5xx/429` handles momentary network blips without switching model families unnecessarily, while failing over to a distinct cloud provider (Google Cloud vs Groq LPU infrastructure) after the second failure isolates us from provider-wide outages.

---

## 7. What We Deliberately Did NOT Build (Scope Cuts)

1. **Frontend Dashboard UI:** Cut completely per guidelines; exposed `GET /v1/usage` returning rich JSON telemetry instead.
2. **Streaming (`stream: true`):** Cut to preserve 100% deterministic token accounting without complex SSE chunk parsers or async reconciliation jobs.
3. **Semantic / Exact Response Caching:** Cut to keep dependencies restricted to Postgres and avoid serving stale non-deterministic responses when `temperature > 0`.
4. **Key CRUD Admin API:** Replaced with a deterministic `seed.ts` CLI script and SHA-256 hashed DB entries to focus engineering hours on the core proxy path.

---

## 8. Decision We Are Least Confident About (Both Sides)

**Heuristic Pre-Flight Input Token Estimation (`char_length / 3`) vs. In-Process Tokenizer (`tiktoken` / `js-tiktoken`)**

* **Why we chose the heuristic:** Running a full BPE tokenizer synchronously on every incoming request adds CPU overhead on the Node.js event loop and requires bundling model-specific vocabulary tables (Llama 3 vs Gemini tokenizers differ). Using a conservative `Math.ceil(chars / 3) + 20` heuristic takes nanoseconds, requires zero WASM/native bindings, and only affects the temporary *reservation* lock for 1–2 seconds—because final settlement always uses the exact token count returned by the upstream provider.
* **The counter-argument (Why this might be wrong):** For payloads heavy in non-Latin scripts (e.g., Devanagari, CJK) or dense JSON/code symbols, token-to-character ratios can approach 1:1. Under our `chars / 3` heuristic, a caller could theoretically under-reserve input tokens by ~2x and slightly exceed their budget on their very last request before the key locks. Conversely, requiring `max_tokens` to be fully reserved upfront means a key with `$0.0005` left will reject a request with `max_tokens: 2000` even if the model would have only replied with 10 words ("Yes.").

---

## 9. Where It Breaks & What We'd Do With One More Week

1. **Orphaned Reservations on Hard Crash (`SIGKILL`):** If the Node.js process is `kill -9`'d mid-flight while waiting for Groq, the `reserved_micro_usd` for that in-flight request remains permanently locked in Postgres.
* *Week 2 Fix:* Create an `in_flight_reservations` table with an `expires_at` timestamp (now + 30s) and a periodic sweeper cron (or lazy cleanup on read) that reclaims stale reservations.

2. **Row-Level Lock Contention on Hot Keys (>500 RPS per single key):** Because `SELECT ... FOR UPDATE` serializes reservations per virtual key in Postgres, a single high-throughput tenant key firing thousands of concurrent requests per second will experience Postgres lock-wait queuing.
* *Week 2 Fix:* Move the hot reservation atomic counter into a **Redis Lua script** (`EVAL` checking `spent + reserved + estimate <= limit`) and flush settled usage logs asynchronously in batches to Postgres via BullMQ.
