import { pgTable, uuid, text, bigint, boolean, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const virtualKeys = pgTable('virtual_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  name: text('name').notNull(),
  budgetLimitMicroUsd: bigint('budget_limit_micro_usd', { mode: 'number' }).notNull(),
  spentMicroUsd: bigint('spent_micro_usd', { mode: 'number' }).notNull().default(0),
  reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usageLogs = pgTable(
  'usage_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    keyId: uuid('key_id')
      .notNull()
      .references(() => virtualKeys.id),
    requestId: text('request_id'),
    requestedModel: text('requested_model').notNull(),
    actualModel: text('actual_model').notNull(),
    providerUsed: text('provider_used').notNull(),
    fallbackTriggered: boolean('fallback_triggered').notNull().default(false),
    fallbackReason: text('fallback_reason'),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    statusCode: integer('status_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_logs_key_id_created_at_idx').on(table.keyId, table.createdAt.desc()),
  ]
);

export const inFlightReservations = pgTable(
  'in_flight_reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    keyId: uuid('key_id')
      .notNull()
      .references(() => virtualKeys.id, { onDelete: 'cascade' }),
    amountMicroUsd: bigint('amount_micro_usd', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('in_flight_reservations_expires_at_idx').on(table.expiresAt),
  ]
);

export const virtualKeysRelations = relations(virtualKeys, ({ many }) => ({
  usageLogs: many(usageLogs),
  inFlightReservations: many(inFlightReservations),
}));

export const usageLogsRelations = relations(usageLogs, ({ one }) => ({
  virtualKey: one(virtualKeys, {
    fields: [usageLogs.keyId],
    references: [virtualKeys.id],
  }),
}));

export const inFlightReservationsRelations = relations(inFlightReservations, ({ one }) => ({
  virtualKey: one(virtualKeys, {
    fields: [inFlightReservations.keyId],
    references: [virtualKeys.id],
  }),
}));

export type VirtualKey = typeof virtualKeys.$inferSelect;
export type NewVirtualKey = typeof virtualKeys.$inferInsert;
export type UsageLog = typeof usageLogs.$inferSelect;
export type NewUsageLog = typeof usageLogs.$inferInsert;
export type InFlightReservation = typeof inFlightReservations.$inferSelect;
export type NewInFlightReservation = typeof inFlightReservations.$inferInsert;
