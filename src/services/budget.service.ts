import { db } from '../db/index.js';
import {
  virtualKeys,
  usageLogs,
  inFlightReservations,
  type NewUsageLog,
} from '../db/schema.js';
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
  reservationId: string;
  keyId: string;
  keyName: string;
  keyPrefix: string;
  reservedMicroUsd: number;
}

/**
 * Phase 1 of Two-Phase Commit: Authenticate key & Pessimistically Reserve budget.
 * Holds a short-lived row-level lock (SELECT ... FOR UPDATE) to eliminate race conditions (TOCTOU).
 * Records an in-flight reservation with an expiration TTL for automated crash recovery.
 * The transaction commits IMMEDIATELY after updating reserved_micro_usd.
 * NEVER holds the transaction while making external LLM calls.
 */
export async function authenticateAndReserve(
  rawKey: string,
  estimatedCostMicroUsd: number,
  ttlSeconds: number = 60
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

    // Record in-flight reservation with TTL for crash safety
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [reservationRow] = await tx
      .insert(inFlightReservations)
      .values({
        keyId: key.id,
        amountMicroUsd: estimatedCostMicroUsd,
        expiresAt,
      })
      .returning({ id: inFlightReservations.id });

    return {
      reservationId: reservationRow.id,
      keyId: key.id,
      keyName: key.name,
      keyPrefix: key.keyPrefix,
      reservedMicroUsd: estimatedCostMicroUsd,
    };
  });
}

/**
 * Phase 2 of Two-Phase Commit: Settle Reservation.
 * Deducts in-flight reservation, deletes in-flight tracking row, increments settled spend
 * with actual cost, and writes the usage log in a single ACID transaction.
 */
export async function settleReservation(
  keyId: string,
  reservedMicroUsd: number,
  actualCostMicroUsd: number,
  logEntry: Omit<NewUsageLog, 'id' | 'keyId' | 'createdAt'>,
  reservationId?: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(virtualKeys)
      .set({
        reservedMicroUsd: sql`GREATEST(0, ${virtualKeys.reservedMicroUsd} - ${reservedMicroUsd})`,
        spentMicroUsd: sql`${virtualKeys.spentMicroUsd} + ${actualCostMicroUsd}`,
      })
      .where(eq(virtualKeys.id, keyId));

    if (reservationId) {
      await tx
        .delete(inFlightReservations)
        .where(eq(inFlightReservations.id, reservationId));
    }

    await tx.insert(usageLogs).values({
      keyId,
      ...logEntry,
    });
  });
}

/**
 * Phase 2 Rollback: Release Reservation on Unrecoverable Error or Client Disconnect.
 * Decrements the in-flight reservation back to 0 and clears tracking row without billing the user.
 */
export async function releaseReservation(
  keyId: string,
  reservedMicroUsd: number,
  reservationId?: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(virtualKeys)
      .set({
        reservedMicroUsd: sql`GREATEST(0, ${virtualKeys.reservedMicroUsd} - ${reservedMicroUsd})`,
      })
      .where(eq(virtualKeys.id, keyId));

    if (reservationId) {
      await tx
        .delete(inFlightReservations)
        .where(eq(inFlightReservations.id, reservationId));
    }
  });
}

/**
 * Sweeps and reclaims orphaned/stale reservations that expired (e.g. from an ungraceful server crash).
 * Restores locked reserved_micro_usd balances on virtual keys.
 */
export async function reclaimStaleReservations(): Promise<{ reclaimedCount: number; restoredMicroUsd: number }> {
  const now = new Date();

  return await db.transaction(async (tx) => {
    const expired = await tx
      .select()
      .from(inFlightReservations)
      .where(sql`${inFlightReservations.expiresAt} <= ${now}`)
      .for('update');

    if (expired.length === 0) {
      return { reclaimedCount: 0, restoredMicroUsd: 0 };
    }

    let restoredMicroUsd = 0;
    for (const res of expired) {
      await tx
        .update(virtualKeys)
        .set({
          reservedMicroUsd: sql`GREATEST(0, ${virtualKeys.reservedMicroUsd} - ${res.amountMicroUsd})`,
        })
        .where(eq(virtualKeys.id, res.keyId));
      restoredMicroUsd += res.amountMicroUsd;
    }

    const expiredIds = expired.map((e) => e.id);
    await tx
      .delete(inFlightReservations)
      .where(sql`${inFlightReservations.id} IN ${expiredIds}`);

    return { reclaimedCount: expired.length, restoredMicroUsd };
  });
}

/**
 * Helper to fetch accurate usage statistics for a key.
 * Queries SQL aggregation for true total count and fallback count across all history.
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

  // True SQL aggregates across entire history
  const [aggregates] = await db
    .select({
      totalRequests: sql<number>`count(*)::int`,
      fallbackCount: sql<number>`count(*) filter (where ${usageLogs.fallbackTriggered} = true)::int`,
    })
    .from(usageLogs)
    .where(eq(usageLogs.keyId, key.id));

  // Recent 20 logs for audit inspection
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

  const totalRequests = Number(aggregates?.totalRequests ?? 0);
  const fallbackCount = Number(aggregates?.fallbackCount ?? 0);

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
