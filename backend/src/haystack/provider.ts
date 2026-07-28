/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentProvider, ProviderContext } from '@/agents'
import { buildWebSocketUrl, encodeDeploymentId } from '@/agents'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import type { RemoteAgentDescriptor } from '@shared/acp-types'
import type {
  AgentConnection,
  AgentDescriptor,
  AgentSpec,
  DeploymentStatusResponse,
  DeployResponse,
  DeployStatus,
} from '@shared/agent-descriptors'
import { DeepsetManagementClient } from './management-client'
import { haystackPipelinesEnvSchema } from './types'

/**
 * Provider id registered into the agent discovery registry. The string is
 * stable: the registry dedupes on it, so re-importing this module never
 * double-registers the provider.
 */
export const haystackProviderId = 'haystack'

/** Injectable dependencies for the provider (test seam for the management client's fetch). */
export type HaystackProviderDeps = {
  fetchFn?: typeof fetch
}

/** Version of {@link haystackDescriptor}; bump when its fields change. */
const haystackSchemaVersion = 1

/**
 * The curated "Add agent" form for Haystack. Phase 1 is curated mode: the owner
 * fixes the pipeline template (`HAYSTACK_TEMPLATE_PIPELINE`), so the user only
 * names the agent. BYO fields (model/key/index) hang off this same descriptor later.
 */
const haystackDescriptor: AgentDescriptor = {
  id: haystackProviderId,
  provider: haystackProviderId,
  name: 'Haystack RAG agent',
  description: 'Deploy a Deepset Cloud pipeline as a chat agent.',
  icon: 'file-search',
  schemaVersion: haystackSchemaVersion,
  action: 'deploy',
  steps: [
    {
      id: 'basics',
      title: 'Name your agent',
      fields: [
        {
          key: 'name',
          label: 'Name',
          widget: 'text',
          required: true,
          maxLength: 60,
          placeholder: 'My research agent',
        },
      ],
    },
  ],
}

/** Whether Haystack is configured to be deployable (base + key + workspace + template). */
const isDeployConfigured = (settings: Settings): boolean =>
  Boolean(
    settings.haystackBaseUrl &&
    settings.haystackApiKey &&
    settings.haystackWorkspace &&
    settings.haystackTemplatePipeline,
  )

/** Map a Deepset pipeline status onto the normalized deploy lifecycle. */
const mapStatus = (deepsetStatus: string): DeployStatus => {
  const status = deepsetStatus.toUpperCase()
  if (status === 'DEPLOYED') {
    return 'running'
  }
  if (status.includes('FAIL')) {
    return 'failed'
  }
  return 'pending'
}

/** Derive a Deepset-safe pipeline name from a user-chosen display name. */
const toPipelineRef = (name: string): string => {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  return `tb-${slug}-${Date.now().toString(36)}`
}

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
export const createHaystackProvider = (deps: HaystackProviderDeps = {}): AgentProvider => {
  const managementClient = (settings: Settings) =>
    new DeepsetManagementClient(
      {
        haystackBaseUrl: settings.haystackBaseUrl,
        haystackApiKey: settings.haystackApiKey,
        haystackWorkspace: settings.haystackWorkspace,
      },
      { fetchFn: deps.fetchFn },
    )

  return {
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
    catalog: ({ settings }: ProviderContext): AgentDescriptor[] =>
      isDeployConfigured(settings) ? [haystackDescriptor] : [],
    deploy: async (spec: AgentSpec, { settings }: ProviderContext): Promise<DeployResponse> => {
      const name = typeof spec.name === 'string' ? spec.name : ''
      const ref = toPipelineRef(name)
      const client = managementClient(settings)
      // Clone the owner-curated template's YAML, create under our `tb-` namespace, then deploy.
      const queryYaml = await client.getPipelineYaml(settings.haystackTemplatePipeline)
      await client.createPipeline({ name: ref, queryYaml })
      const deployed = await client.deployPipeline(ref)
      return { deploymentId: encodeDeploymentId(haystackProviderId, ref), status: mapStatus(deployed.status) }
    },
    status: async (ref: string, { request, settings }: ProviderContext): Promise<DeploymentStatusResponse> => {
      const pipeline = await managementClient(settings).getPipeline(ref)
      const status = mapStatus(pipeline.status)
      const connection: AgentConnection | null =
        status === 'running'
          ? {
              url: buildWebSocketUrl(request, `/haystack/ws?pipeline=${encodeURIComponent(ref)}`),
              transport: 'websocket',
            }
          : null
      return { deploymentId: encodeDeploymentId(haystackProviderId, ref), status, detail: pipeline.status, connection }
    },
  }
}

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
