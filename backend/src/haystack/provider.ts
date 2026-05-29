/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentProvider } from '@/agents'
import { buildWebSocketUrl } from '@/agents'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import type { RemoteAgentDescriptor } from '@shared/acp-types'
import { haystackPipelinesEnvSchema } from './types'

/**
 * Provider id registered into the agent discovery registry. The string is
 * stable: the registry dedupes on it, so re-importing this module never
 * double-registers the provider.
 */
export const haystackProviderId = 'haystack'

/**
 * Build the Haystack provider. Reads `HAYSTACK_PIPELINES` (JSON array) from
 * the injected `settings`. An empty / missing / malformed value yields an
 * empty descriptor list — we log and skip rather than throw so a deployment
 * with no Haystack config doesn't fail other providers.
 *
 * Each pipeline becomes a `managed-acp`, websocket-transport descriptor whose
 * URL points at `/v1/haystack/ws?pipeline=<pipelineId>`. The host is derived
 * from the inbound `Request` via {@link buildWebSocketUrl} so dev (`ws://`)
 * and prod (`wss://` behind a reverse proxy) both produce correct URLs
 * without env-var pinning.
 */
export const createHaystackProvider = (): AgentProvider => ({
  id: haystackProviderId,
  list: (request: Request, settings: Settings): RemoteAgentDescriptor[] => {
    const pipelines = parsePipelinesEnv(settings)
    if (pipelines.length === 0) {
      return []
    }
    return pipelines.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      type: 'managed-acp',
      transport: 'websocket',
      // URL carries the public slug — the WS route resolves it back to the
      // Deepset pipelineName / pipelineId from the same env-driven descriptor.
      url: buildWebSocketUrl(request, `/haystack/ws?pipeline=${encodeURIComponent(pipeline.id)}`),
      description: pipeline.description ?? null,
      icon: pipeline.icon ?? null,
      isSystem: 1,
    }))
  },
})

/**
 * Parse `HAYSTACK_PIPELINES` from settings. The env var is a JSON-encoded
 * array of {@link haystackPipelinesEnvSchema} entries. Empty / missing values
 * return `[]`. A malformed value also returns `[]` but is logged at WARN —
 * silent dropping would hide a deployment-side typo, but throwing would
 * cascade into a `GET /agents` 500 for unrelated providers (the discovery
 * route catches the throw, but the operator wouldn't get a structured signal).
 */
export const parsePipelinesEnv = (settings: Settings) => {
  const raw = settings.haystackPipelines.trim()
  if (raw.length === 0) {
    return []
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    const log = createStandaloneLogger(settings)
    log.warn({ err }, 'HAYSTACK_PIPELINES is not valid JSON; ignoring')
    return []
  }
  const result = haystackPipelinesEnvSchema.safeParse(parsedJson)
  if (!result.success) {
    const log = createStandaloneLogger(settings)
    log.warn({ issues: result.error.issues }, 'HAYSTACK_PIPELINES schema mismatch; ignoring')
    return []
  }
  return result.data
}
