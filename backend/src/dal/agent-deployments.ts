/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { agentDeployments } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

/** Record a deployment so its inference token is accepted. Idempotent. */
export const recordAgentDeployment = async (
  database: typeof DbType,
  { deploymentId, userId }: { deploymentId: string; userId: string },
) =>
  database
    .insert(agentDeployments)
    .values({ deploymentId, userId })
    .onConflictDoNothing({ target: agentDeployments.deploymentId })

/** Revoke a deployment, killing its inference token. Re-revoking is a no-op. */
export const revokeAgentDeployment = async (database: typeof DbType, deploymentId: string) =>
  database
    .update(agentDeployments)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentDeployments.deploymentId, deploymentId), isNull(agentDeployments.revokedAt)))
    .returning()

/** Look up a deployment's owner and revocation state. Returns null if unknown. */
export const getAgentDeployment = async (
  database: typeof DbType,
  deploymentId: string,
): Promise<{ userId: string; revokedAt: Date | null } | null> =>
  database
    .select({ userId: agentDeployments.userId, revokedAt: agentDeployments.revokedAt })
    .from(agentDeployments)
    .where(eq(agentDeployments.deploymentId, deploymentId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
