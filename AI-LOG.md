# AI Collaboration & Verification Log (`AI-LOG.md`)

## 1. AI Tools & Models Used
* **Google Antigravity IDE + Claude / Gemini Pro:** Used for project scaffolding, Drizzle ORM schema generation, boilerplate Express route wiring, and drafting Vitest/Supertest integration harnesses.
* **How we divided the labor:** I defined the system architecture, failure modes, database locking semantics (`SELECT ... FOR UPDATE`), and integer micro-USD accounting invariants upfront in a structured specification (`PLAN.md`), then directed the coding agent phase-by-phase to implement and test each module.

---

## 2. One Place the AI Was Wrong / Misleading & How We Caught It
* **The Bug:** When initially generating the budget enforcement flow, the AI suggested wrapping the entire request lifecycle—including the `await fetch()` call to the upstream LLM provider—inside a single `db.transaction(async (tx) => { ... })` block using `SELECT ... FOR UPDATE`.
* **How I Caught It:** During code review of `budget.service.ts` and `chat.route.ts`, I immediately flagged this as a critical production anti-pattern. Holding an open PostgreSQL transaction and row lock across an external HTTP call that can take 2 to 18 seconds (with retries and fallback) would exhaust the `pg.Pool` connection limit under just 20 concurrent requests and cause severe database lock contention.
* **The Fix:** I decoupled the lifecycle into a strict **Two-Phase Reservation** pattern (`authenticateAndReserve` -> commit -> external LLM HTTP call -> `settleReservation` / `releaseReservation`). Now each DB transaction executes in <5ms, completely isolating the database connection pool from upstream LLM network latency.

---

## 3. One Place We Overrode the AI's Suggestion & Why
* **The AI's Suggestion:** The AI initially proposed storing budgets and costs using PostgreSQL `DOUBLE PRECISION` (or JavaScript `number` floats in dollars, e.g., `0.00042`) and recommended integrating the official `@anthropic-ai/sdk` and `openai` npm packages with automatic built-in retries.
* **Why I Overrode It:**
  1. **Floating-Point Drift:** Financial ledgers must never use binary floating-point math (`0.1 + 0.2 !== 0.3`). I enforced integer **micro-USD** (`1 USD = 1,000,000 micro-USD` stored as `BIGINT`) across the schema and pricing calculator.
  2. **Explicit Retry/Timeout Control:** Heavy vendor SDKs hide retry timers and error classification behind opaque abstractions, making it hard to enforce a deterministic 250ms single-retry + cross-provider fallback SLA or distinguish a fast-fail `400` from a retryable `503`. I overrode the SDK suggestion in favor of native Node.js `fetch` paired with explicit `AbortSignal.timeout()` controllers.

---

## 4. Staying in Control of Critical Code (Secrets, Budgets, Provider Calls)
To guarantee that no hallucinated logic slipped into critical paths, I enforced three guardrails:
1. **Secret Isolation & Key Hashing:** Verified that `src/config/env.ts` validates all provider keys (`GROQ_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`) at boot via Zod, never logs them, and that raw virtual keys (`rok_...`) are hashed via `crypto.createHash('sha256')` before hitting Postgres so plaintext client tokens don't even exist in the database.
2. **Deterministic Concurrency Test (`Promise.all` Race Test):** Instead of trusting the AI that the budget lock worked, I required an automated Supertest integration test (`tests/gateway.test.ts`) that fires 3 simultaneous requests against a virtual key seeded with only enough micro-USD (`1,500` micro-USD) for a single request. The test asserts that exactly 1 request returns `200 OK` and 2 return `402 Payment Required`, proving the TOCTOU lock works under race conditions.
3. **Failure-Injection Header (`x-simulate-primary-failure`):** Rather than hoping the fallback logic worked in theory, I built a deterministic failure hook so we could trigger and verify the exact primary -> retry -> Gemini fallback path and verify `reserved_micro_usd` cleanup in real time.

---

## 5. What I Learned From Scratch This Weekend
* **Cross-Provider OpenAI Schema Quirks & Pre-Flight Worst-Case Reservation Sizing:** While I had built Postgres `FOR UPDATE SKIP LOCKED` worker queues before, applying pessimistic locking to *variable-cost* LLM calls required figuring out how to price a request *before* knowing how many output tokens the LLM will actually generate. I learned how to bound worst-case reservation exposure by enforcing a mandatory default ceiling on `max_tokens` (512 default, 4096 max) and pricing the pre-flight reservation against the higher of the primary and fallback model rates—then refunding the difference during the settlement transaction.
