import { db, pool } from './index.js';
import { virtualKeys } from './schema.js';
import { hashKey } from '../utils/crypto.js';
import { eq } from 'drizzle-orm';

export const TEST_KEYS = {
  RICH: 'rok_test_rich_1000000_abc123',
  TIGHT: 'rok_test_tight_0001500_def456',
  EMPTY: 'rok_test_empty_0000000_ghi789',
} as const;

export const SEED_DATA = [
  {
    rawKey: TEST_KEYS.RICH,
    name: 'test-rich-standard',
    budgetLimitMicroUsd: 1_000_000, // $1.00
    description: 'Rich test key ($1.00 / 1,000,000 µUSD) for standard and fallback calls',
  },
  {
    rawKey: TEST_KEYS.TIGHT,
    name: 'test-tight-concurrency',
    budgetLimitMicroUsd: 1_500, // $0.0015
    description: 'Tight budget key ($0.0015 / 1,500 µUSD) for TOCTOU concurrency race tests',
  },
  {
    rawKey: TEST_KEYS.EMPTY,
    name: 'test-empty-exhausted',
    budgetLimitMicroUsd: 0, // $0.00
    description: 'Exhausted key ($0.00 / 0 µUSD) for immediate 402 rejection tests',
  },
];

export async function seed() {
  console.log('--- Seeding Virtual Keys into Database ---');

  for (const item of SEED_DATA) {
    const keyHash = hashKey(item.rawKey);
    const keyPrefix = item.rawKey.slice(0, 10);

    const existing = await db
      .select()
      .from(virtualKeys)
      .where(eq(virtualKeys.keyHash, keyHash))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(virtualKeys)
        .set({
          name: item.name,
          keyPrefix,
          budgetLimitMicroUsd: item.budgetLimitMicroUsd,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          isActive: true,
        })
        .where(eq(virtualKeys.keyHash, keyHash));
      console.log(`[UPDATED] Key: ${item.rawKey} | Budget: ${item.budgetLimitMicroUsd} µUSD`);
    } else {
      await db.insert(virtualKeys).values({
        keyHash,
        keyPrefix,
        name: item.name,
        budgetLimitMicroUsd: item.budgetLimitMicroUsd,
        spentMicroUsd: 0,
        reservedMicroUsd: 0,
        isActive: true,
      });
      console.log(`[INSERTED] Key: ${item.rawKey} | Budget: ${item.budgetLimitMicroUsd} µUSD`);
    }
  }

  console.log('--- Seed Completed Successfully ---');
}

// Run if called directly
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed()
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await pool.end();
    });
}
