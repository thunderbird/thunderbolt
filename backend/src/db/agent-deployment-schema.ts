/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

/**
 * Revocation authority for the per-deployment inference JWTs
 * (backend/src/agents/inference-token.ts). One row per deployed sandbox agent.
 * Because those tokens are non-expiring by design, this table is the only kill
 * switch: `/v1/chat/completions` rejects a token whose deployment is missing or
 * has a non-null `revokedAt`. Backend-only (`public` schema) — it must NOT sync
 * to clients via PowerSync.
 */
export const agentDeployments = pgTable(
  'agent_deployments',
  {
    deploymentId: text('deployment_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('agent_deployments_user_id_idx').on(t.userId)],
)
