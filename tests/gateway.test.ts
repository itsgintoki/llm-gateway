import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { virtualKeys, usageLogs, inFlightReservations } from '../src/db/schema.js';
import { seed, TEST_KEYS } from '../src/db/seed.js';
import { hashKey } from '../src/utils/crypto.js';
import {
  estimateWorstCaseReservationMicroUsd,
  PRIMARY_MODEL,
} from '../src/config/pricing.js';
import { reclaimStaleReservations } from '../src/services/budget.service.js';
import { resetCircuitBreaker } from '../src/services/llm.service.js';
import { eq, sql } from 'drizzle-orm';

describe('LLM Gateway Integration & Concurrency Test Suite', () => {
  beforeAll(async () => {
    await seed();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Reset seed data and circuit state before each test for clean deterministic state
    resetCircuitBreaker();
    await seed();
  });

  describe('Health Endpoint', () => {
    it('returns 200, a healthy DB status, and a closed circuit breaker', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.circuit_breaker).toBe('CLOSED');
    });
  });

  describe('1. Authentication Verification', () => {
    it('rejects missing, malformed, and unknown Authorization headers (401)', async () => {
      const send = (authorization?: string) => {
        const req = request(app).post('/v1/chat/completions');
        if (authorization !== undefined) req.set('Authorization', authorization);
        return req.send({ messages: [{ role: 'user', content: 'Hello' }] });
      };

      for (const authorization of [undefined, 'Basic 123456', 'Bearer rok_invalid_key_99999999']) {
        const res = await send(authorization);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('unauthorized');
      }
    });
  });

  describe('Validation & Stream Rejection', () => {
    it('rejects stream: true with 400 and clear deterministic accounting explanation', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TEST_KEYS.RICH}`)
        .send({
          messages: [{ role: 'user', content: 'Tell me a story' }],
          stream: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request_error');
      expect(JSON.stringify(res.body)).toContain('not supported');
    });

    it('rejects empty messages array with 400', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TEST_KEYS.RICH}`)
        .send({
          messages: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request_error');
    });
  });

  describe('2. Budget Exhaustion Verification', () => {
    it('immediately rejects exhausted key rok_test_empty with 402 and creates 0 usage logs', async () => {
      const emptyHash = hashKey(TEST_KEYS.EMPTY);
      const [keyBefore] = await db
        .select()
        .from(virtualKeys)
        .where(eq(virtualKeys.keyHash, emptyHash));

      expect(keyBefore.budgetLimitMicroUsd).toBe(0);

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TEST_KEYS.EMPTY}`)
        .send({
          messages: [{ role: 'user', content: 'What is 1+1?' }],
          max_tokens: 128,
        });

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('budget_exceeded');
      expect(res.body.error.budget_limit_micro_usd).toBe(0);

      // Verify no provider logs were generated
      const logs = await db
        .select()
        .from(usageLogs)
        .where(eq(usageLogs.keyId, keyBefore.id));
      expect(logs.length).toBe(0);
    });
  });

  describe('3. TOCTOU Concurrency Proof (Zero-Trust Pessimistic Reservation)', () => {
    it('fires 3 simultaneous requests against tight budget key: exactly 1 succeeds (200) and 2 are rejected (402)', async () => {
      // rok_test_tight has a budget of 1,500 µUSD.
      // With max_tokens = 1500, estimated worst-case reservation is ~1,204 µUSD.
      // 1 request requires 1,204 µUSD <= 1,500 (succeeds).
      // Any simultaneous request will require another 1,204 µUSD -> (1,204 + 1,204 = 2,408 > 1,500) -> blocked!
      const payload = {
        messages: [{ role: 'user', content: 'Concurrent test prompt for gateway race testing' }],
        max_tokens: 1500,
      };

      const sendRequest = () =>
        request(app)
          .post('/v1/chat/completions')
          .set('Authorization', `Bearer ${TEST_KEYS.TIGHT}`)
          .send(payload);

      // Dispatch 3 simultaneous requests concurrently via Promise.all
      const responses = await Promise.all([sendRequest(), sendRequest(), sendRequest()]);

      const successResponses = responses.filter((r) => r.status === 200);
      const rejectedResponses = responses.filter((r) => r.status === 402);

      // Concurrency Proof: Exactly 1 succeeds, exactly 2 rejected
      expect(successResponses.length).toBe(1);
      expect(rejectedResponses.length).toBe(2);

      // Verify error bodies on rejected requests
      for (const rej of rejectedResponses) {
        expect(rej.body.error.code).toBe('budget_exceeded');
        expect(rej.body.error.budget_limit_micro_usd).toBe(1500);
      }

      // Check database state after all concurrent requests complete:
      const tightHash = hashKey(TEST_KEYS.TIGHT);
      const [keyAfter] = await db
        .select()
        .from(virtualKeys)
        .where(eq(virtualKeys.keyHash, tightHash));

      // Reserved must be cleanly released back to 0
      expect(keyAfter.reservedMicroUsd).toBe(0);
      // Spent must reflect the settled amount of the single successful request
      expect(keyAfter.spentMicroUsd).toBeGreaterThan(0);
      expect(keyAfter.spentMicroUsd).toBeLessThanOrEqual(1500);
    });
  });

  describe('4. Provider Fallback Trigger Verification', () => {
    it('routes to gemini-fallback and returns 200 OK when x-simulate-primary-failure is passed', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TEST_KEYS.RICH}`)
        .set('x-simulate-primary-failure', 'true')
        .send({
          messages: [{ role: 'user', content: 'Explain quantum entanglement' }],
          max_tokens: 128,
        });

      expect(res.status).toBe(200);
      expect(res.body.x_gateway).toBeDefined();
      expect(res.body.x_gateway.fallback_triggered).toBe(true);
      expect(res.body.x_gateway.provider_used).toBe('gemini-fallback');
      expect(res.body.x_gateway.cost_micro_usd).toBeGreaterThan(0);
      expect(res.body.choices[0].message.content).toBeDefined();

      // Verify database record has fallback logged
      const richHash = hashKey(TEST_KEYS.RICH);
      const [richKey] = await db
        .select()
        .from(virtualKeys)
        .where(eq(virtualKeys.keyHash, richHash));

      const logs = await db
        .select()
        .from(usageLogs)
        .where(eq(usageLogs.keyId, richKey.id));

      const fallbackLog = logs.find((l) => l.fallbackTriggered);
      expect(fallbackLog).toBeDefined();
      expect(fallbackLog?.providerUsed).toBe('gemini-fallback');
      expect(fallbackLog?.fallbackReason).toContain('Simulated primary failure');
    });
  });

  describe('5. Spend Accounting & Usage Verification', () => {
    it('accurately tracks spend on GET /v1/usage via Bearer token and query param', async () => {
      // 1. Make a successful standard request with rich key
      const chatRes = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TEST_KEYS.RICH}`)
        .send({
          messages: [{ role: 'user', content: 'Hello gateway' }],
          max_tokens: 64,
        });
      expect(chatRes.status).toBe(200);

      // 2. Query usage via Authorization Bearer header
      const usageResHeader = await request(app)
        .get('/v1/usage')
        .set('Authorization', `Bearer ${TEST_KEYS.RICH}`);

      expect(usageResHeader.status).toBe(200);
      expect(usageResHeader.body.key_name).toBe('test-rich-standard');
      expect(usageResHeader.body.key_prefix).toBe(TEST_KEYS.RICH.slice(0, 10));
      expect(usageResHeader.body.budget_limit_micro_usd).toBe(1_000_000);
      expect(usageResHeader.body.spent_micro_usd).toBeGreaterThan(0);
      expect(usageResHeader.body.reserved_micro_usd).toBe(0);
      expect(usageResHeader.body.remaining_micro_usd).toBeLessThan(1_000_000);
      expect(usageResHeader.body.spend_usd_formatted).toMatch(/^\$0\.\d{6}$/);
      expect(usageResHeader.body.total_requests).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(usageResHeader.body.recent_logs)).toBe(true);
      expect(usageResHeader.body.recent_logs.length).toBeGreaterThanOrEqual(1);

      // 3. Query usage via ?key= query param
      const usageResQuery = await request(app)
        .get(`/v1/usage?key=${TEST_KEYS.RICH}`);

      expect(usageResQuery.status).toBe(200);
      expect(usageResQuery.body.spent_micro_usd).toBe(usageResHeader.body.spent_micro_usd);
    });

    it('reports accurate aggregate total_requests even when usage logs exceed the 20-row limit', async () => {
      const richHash = hashKey(TEST_KEYS.RICH);
      const [key] = await db
        .select()
        .from(virtualKeys)
        .where(eq(virtualKeys.keyHash, richHash));

      // Insert 25 mock log rows into database
      const batchLogs = Array.from({ length: 25 }, (_, i) => ({
        keyId: key.id,
        requestId: `req_test_batch_${i}`,
        requestedModel: PRIMARY_MODEL,
        actualModel: PRIMARY_MODEL,
        providerUsed: 'groq',
        fallbackTriggered: i % 5 === 0, // 5 fallbacks
        promptTokens: 10,
        completionTokens: 10,
        costMicroUsd: 10,
        latencyMs: 50,
        statusCode: 200,
      }));

      await db.insert(usageLogs).values(batchLogs);

      const usageRes = await request(app)
        .get('/v1/usage')
        .set('Authorization', `Bearer ${TEST_KEYS.RICH}`);

      expect(usageRes.status).toBe(200);
      // Aggregate must reflect at least 25 total requests, not 20
      expect(usageRes.body.total_requests).toBeGreaterThanOrEqual(25);
      // Recent logs array is still cleanly capped at 20 for preview
      expect(usageRes.body.recent_logs.length).toBe(20);
    });
  });

  describe('6. Model-Aware Worst-Case Reservation Sizing', () => {
    it('calculates higher pre-flight worst-case reservation for expensive models', () => {
      const messages = [{ role: 'user', content: 'Price check' }];
      const standardCost = estimateWorstCaseReservationMicroUsd(messages, 500, PRIMARY_MODEL);
      const expensiveCost = estimateWorstCaseReservationMicroUsd(messages, 500, 'openai/gpt-oss-120b');

      expect(expensiveCost).toBeGreaterThan(standardCost);
    });
  });

  describe('7. Orphaned Reservation Recovery Sweeper', () => {
    it('reclaims expired in-flight reservations and restores virtual key balance', async () => {
      const richHash = hashKey(TEST_KEYS.RICH);
      const [key] = await db
        .select()
        .from(virtualKeys)
        .where(eq(virtualKeys.keyHash, richHash));

      // Simulate a crashed process that left 500 µUSD locked in reservation
      await db
        .update(virtualKeys)
        .set({
          reservedMicroUsd: sql`${virtualKeys.reservedMicroUsd} + 500`,
        })
        .where(eq(virtualKeys.id, key.id));

      // Insert an expired in-flight reservation row (expired 10 seconds ago)
      await db.insert(inFlightReservations).values({
        keyId: key.id,
        amountMicroUsd: 500,
        expiresAt: new Date(Date.now() - 10_000),
      });

      // Run sweeper
      const { reclaimedCount, restoredMicroUsd } = await reclaimStaleReservations();
      expect(reclaimedCount).toBeGreaterThanOrEqual(1);
      expect(restoredMicroUsd).toBeGreaterThanOrEqual(500);

      // Verify the virtual key's reservedMicroUsd was restored
      const [updatedKey] = await db
        .select()
        .from(virtualKeys)
        .where(eq(virtualKeys.id, key.id));
      expect(updatedKey.reservedMicroUsd).toBe(0);
    });
  });
});
