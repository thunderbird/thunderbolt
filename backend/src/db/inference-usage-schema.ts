/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

export const inferencePrices = pgTable(
  'inference_prices',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputNanoUsdPerToken: bigint('input_nano_usd_per_token', { mode: 'bigint' }).notNull(),
    outputNanoUsdPerToken: bigint('output_nano_usd_per_token', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.model] }),
    check('inference_prices_input_nonnegative', sql`${table.inputNanoUsdPerToken} >= 0`),
    check('inference_prices_output_nonnegative', sql`${table.outputNanoUsdPerToken} >= 0`),
  ],
)

export const inferenceUsage = pgTable(
  'inference_usage',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    costNanoUsd: bigint('cost_nano_usd', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('inference_usage_user_id_created_at_idx').on(table.userId, table.createdAt),
    check('inference_usage_prompt_nonnegative', sql`${table.promptTokens} >= 0`),
    check('inference_usage_completion_nonnegative', sql`${table.completionTokens} >= 0`),
    check('inference_usage_total_nonnegative', sql`${table.totalTokens} >= 0`),
    check('inference_usage_cost_nonnegative', sql`${table.costNanoUsd} >= 0`),
  ],
)
