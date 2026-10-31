import { db } from '../db/index.js';
import { virtualKeys, usageLogs, type NewUsageLog, type VirtualKey } from '../db/schema.js';
import { hashKey } from '../utils/crypto.js';
import { eq, sql } from 'drizzle-orm';

export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly payload: Record<string, unknown>
  ) {
    super((payload.error as { message?: string })?.message || 'Gateway Error');
    this.name = 'GatewayError';
  }
}

export class UnauthorizedError extends GatewayError {
  constructor(message: string = 'Invalid or inactive API key') {
    super(401, {
      error: {
        code: 'unauthorized',
        message,
      },
    });
  }
}

export class BudgetExceededError extends GatewayError {
  constructor(details: {
    budgetLimitMicroUsd: number;
    spentMicroUsd: number;
    reservedMicroUsd: number;
    requiredReservationMicroUsd: number;
  }) {
    super(402, {
      error: {
        code: 'budget_exceeded',
        message: 'Key budget exhausted or insufficient available balance for worst-case request cost.',
        budget_limit_micro_usd: details.budgetLimitMicroUsd,
        spent_micro_usd: details.spentMicroUsd,
        reserved_micro_usd: details.reservedMicroUsd,
        required_reservation_micro_usd: details.requiredReservationMicroUsd,
      },
    });
  }
}

export interface ReservationResult {
  keyId: string;
  keyName: string;
  keyPrefix: string;
  reservedMicroUsd: number;
}

/**
 * Phase 1 of Two-Phase Commit: Authenticate key & Pessimistically Reserve budget.
 * Holds a short-lived row-level lock (SELECT ... FOR UPDATE) to eliminate race conditions (TOCTOU).
 * The transaction commits IMMEDIATELY after updating reserved_micro_usd.
 * NEVER holds the transaction while making external LLM calls.
 */
export async function authenticateAndReserve(
  rawKey: string,
  estimatedCostMicroUsd: number
): Promise<ReservationResult> {
  const keyHash = hashKey(rawKey);

  return await db.transaction(async (tx) => {
    // Row-level lock on the specific virtual key
    const rows = await tx
      .select()
      .from(virtualKeys)
      .where(eq(virtualKeys.keyHash, keyHash))
      .for('update');

    const key = rows[0];

    if (!key || !key.isActive) {
      throw new UnauthorizedError();
    }

    const currentSpent = Number(key.spentMicroUsd);
    const currentReserved = Number(key.reservedMicroUsd);
    const budgetLimit = Number(key.budgetLimitMicroUsd);

    if (currentSpent + currentReserved + estimatedCostMicroUsd > budgetLimit) {
      throw new BudgetExceededError({
        budgetLimitMicroUsd: budgetLimit,
        spentMicroUsd: currentSpent,
        reservedMicroUsd: currentReserved,
        requiredReservationMicroUsd: estimatedCostMicroUsd,
      });
    }

    // Atomically increment the reservation
    await tx
      .update(virtualKeys)
      .set({
        reservedMicroUsd: sql`${virtualKeys.reservedMicroUsd} + ${estimatedCostMicroUsd}`,
      })
      .where(eq(virtualKeys.id, key.id));

    return {
      keyId: key.id,
      keyName: key.name,
      keyPrefix: key.keyPrefix,
      reservedMicroUsd: estimatedCostMicroUsd,
    };
  });
}

/**
 * Phase 2 of Two-Phase Commit: Settle Reservation.
 * Deducts in-flight reservation, increments settled spend with actual cost,
 * and writes the usage log in a single ACID transaction.
 */
export async function settleReservation(
  keyId: string,
  reservedMicroUsd: number,
  actualCostMicroUsd: number,
  logEntry: Omit<NewUsageLog, 'id' | 'keyId' | 'createdAt'>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(virtualKeys)
      .set({
        reservedMicroUsd: sql`GREATEST(0, ${virtualKeys.reservedMicroUsd} - ${reservedMicroUsd})`,
        spentMicroUsd: sql`${virtualKeys.spentMicroUsd} + ${actualCostMicroUsd}`,
      })
      .where(eq(virtualKeys.id, keyId));

    await tx.insert(usageLogs).values({
      keyId,
      ...logEntry,
    });
  });
}

/**
 * Phase 2 Rollback: Release Reservation on Unrecoverable Error.
 * Decrements the in-flight reservation back to 0 without billing the user.
 */
export async function releaseReservation(
  keyId: string,
  reservedMicroUsd: number
): Promise<void> {
  await db
    .update(virtualKeys)
    .set({
      reservedMicroUsd: sql`GREATEST(0, ${virtualKeys.reservedMicroUsd} - ${reservedMicroUsd})`,
    })
    .where(eq(virtualKeys.id, keyId));
}

/**
 * Helper to fetch usage statistics for a key.
 */
export async function getKeyUsage(rawKeyOrHash: string, isRaw: boolean = true) {
  const keyHash = isRaw ? hashKey(rawKeyOrHash) : rawKeyOrHash;

  const [key] = await db
    .select()
    .from(virtualKeys)
    .where(eq(virtualKeys.keyHash, keyHash))
    .limit(1);

  if (!key || !key.isActive) {
    throw new UnauthorizedError();
  }

  const logs = await db
    .select()
    .from(usageLogs)
    .where(eq(usageLogs.keyId, key.id))
    .orderBy(sql`${usageLogs.createdAt} DESC`)
    .limit(20);

  const spentMicroUsd = Number(key.spentMicroUsd);
  const reservedMicroUsd = Number(key.reservedMicroUsd);
  const budgetLimitMicroUsd = Number(key.budgetLimitMicroUsd);
  const remainingMicroUsd = Math.max(0, budgetLimitMicroUsd - spentMicroUsd - reservedMicroUsd);
  const spendUsdFormatted = `$${(spentMicroUsd / 1_000_000).toFixed(6)}`;

  const totalRequests = logs.length;
  const fallbackCount = logs.filter((l) => l.fallbackTriggered).length;

  return {
    key_name: key.name,
    key_prefix: key.keyPrefix,
    budget_limit_micro_usd: budgetLimitMicroUsd,
    spent_micro_usd: spentMicroUsd,
    reserved_micro_usd: reservedMicroUsd,
    remaining_micro_usd: remainingMicroUsd,
    spend_usd_formatted: spendUsdFormatted,
    total_requests: totalRequests,
    fallback_count: fallbackCount,
    recent_logs: logs,
  };
}
