/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { parseResourceIdentity } from '@shared/cloud-agent/crypto'

const integer = (fallback: number, maximum: number) => z.coerce.number().int().min(1).max(maximum).default(fallback)
const environment = z.object({
  CLOUD_AGENT_OAUTH_CALLBACK_URL: z.string().url().optional(),
  CLOUD_AGENT_OAUTH_RETURN_URL: z.string().url().optional(),
  CLOUD_AGENTS_ENABLED: z.enum(['true', 'false']).default('false'),
  CLOUD_AGENT_RUNTIME_IDENTITY: z.string().optional(),
  CLOUD_AGENT_EXECUTION_ENABLED: z.enum(['true', 'false']).default('true'),
  CLOUD_AGENT_MAX_CONCURRENT: integer(8, 128),
  CLOUD_AGENT_MAX_PER_OWNER: integer(25, 1000),
  CLOUD_AGENT_MAX_ARTIFACT_BYTES: integer(5_000_000, 100_000_000),
  CLOUD_AGENT_MAX_STORAGE_BYTES: integer(100_000_000, 1_000_000_000_000),
  CLOUD_AGENT_OWNER_DAILY_BUDGET_USD: z.coerce.number().positive().max(10000).default(20),
})

/** A restore can serve saved data while execution remains explicitly disabled. */
export const readCloudSettings = (env: NodeJS.ProcessEnv = process.env) => {
  const parsed = environment.parse(env)
  const enabled = parsed.CLOUD_AGENTS_ENABLED === 'true'
  if (enabled && !parsed.CLOUD_AGENT_RUNTIME_IDENTITY) {
    throw new Error('CLOUD_AGENT_RUNTIME_IDENTITY is required')
  }
  return {
    enabled,
    executionEnabled: parsed.CLOUD_AGENT_EXECUTION_ENABLED === 'true',
    identity: parsed.CLOUD_AGENT_RUNTIME_IDENTITY
      ? parseResourceIdentity(JSON.parse(parsed.CLOUD_AGENT_RUNTIME_IDENTITY))
      : null,
    maxConcurrentRuns: parsed.CLOUD_AGENT_MAX_CONCURRENT,
    maxAgents: parsed.CLOUD_AGENT_MAX_PER_OWNER,
    maxArtifactBytes: parsed.CLOUD_AGENT_MAX_ARTIFACT_BYTES,
    maxStorageBytes: parsed.CLOUD_AGENT_MAX_STORAGE_BYTES,
    ownerDailyBudgetUsd: parsed.CLOUD_AGENT_OWNER_DAILY_BUDGET_USD,
    oauthCallbackUrl: parsed.CLOUD_AGENT_OAUTH_CALLBACK_URL,
    oauthReturnUrl: parsed.CLOUD_AGENT_OAUTH_RETURN_URL,
  }
}

export type CloudSettings = ReturnType<typeof readCloudSettings>
