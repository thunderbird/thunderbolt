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
import { DeepsetManagementClient, DeepsetManagementError } from './management-client'

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
  description: 'Deploy a Haystack pipeline as a chat agent.',
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

/** Whether Haystack is configured to talk to Deepset at all (discovery + chat). */
const isHaystackConfigured = (settings: Settings): boolean =>
  Boolean(settings.haystackBaseUrl && settings.haystackApiKey && settings.haystackWorkspace)

/** Whether Haystack is also deployable (needs a template pipeline to clone). */
const isDeployConfigured = (settings: Settings): boolean =>
  isHaystackConfigured(settings) && Boolean(settings.haystackTemplatePipeline)

/**
 * Map a Deepset pipeline status onto our normalized deploy lifecycle. Deepset
 * `PipelineStatus`: DEPLOYMENT_IN_PROGRESS, ACTIVATING (transient → `pending`);
 * DEPLOYED and IDLE (both usable — an auto-idled pipeline wakes on query →
 * `running`); DEPLOYMENT_FAILED (`failed`); UNDEPLOYED, UNDEPLOYMENT_IN_PROGRESS
 * (unusable → `gone`, alongside a not-found host lookup).
 */
const mapStatus = (deepsetStatus: string): DeployStatus => {
  const status = deepsetStatus.toUpperCase()
  if (status === 'DEPLOYMENT_IN_PROGRESS' || status === 'ACTIVATING') {
    return 'pending'
  }
  if (status === 'DEPLOYED' || status === 'IDLE') {
    return 'running'
  }
  if (status.includes('FAIL')) {
    return 'failed'
  }
  return 'gone'
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

/** Construct a management client from settings (shared by the provider verbs and the WS resolver). */
const makeManagementClient = (settings: Settings, deps: HaystackProviderDeps): DeepsetManagementClient =>
  new DeepsetManagementClient(
    {
      haystackBaseUrl: settings.haystackBaseUrl,
      haystackApiKey: settings.haystackApiKey,
      haystackWorkspace: settings.haystackWorkspace,
    },
    { fetchFn: deps.fetchFn },
  )

/** A pipeline resolved for a live chat connection. */
export type ResolvedPipeline = { pipelineId: string; pipelineName: string; supportsFiles: boolean }

/**
 * Resolve a `?pipeline=` slug to its Deepset identifiers for the WS route by
 * looking it up live (the slug is the Deepset pipeline name). Returns null for
 * unknown / unconfigured slugs so the caller can close the socket. Pipelines are
 * treated as text-only for now (`supportsFiles: false`).
 */
export const resolveHaystackPipeline = async (
  slug: string,
  settings: Settings,
  deps: HaystackProviderDeps = {},
): Promise<ResolvedPipeline | null> => {
  if (!isHaystackConfigured(settings)) {
    return null
  }
  try {
    const pipeline = await makeManagementClient(settings, deps).getPipeline(slug)
    return { pipelineId: pipeline.pipeline_id, pipelineName: slug, supportsFiles: false }
  } catch {
    return null
  }
}

/**
 * Build the Haystack provider. `list()` fetches the workspace's pipelines live
 * from Deepset — `DEPLOYED`, prompt-capable, and excluding Thunderbolt-deployed
 * `tb-*` instances (those are user-owned and live in the synced `agents` table).
 * On any host error it logs and returns `[]` so discovery never fails.
 *
 * Each pipeline becomes a `managed-acp`, websocket descriptor whose URL points at
 * `/v1/haystack/ws?pipeline=<name>`; the host is derived from the inbound request
 * via {@link buildWebSocketUrl} so dev (`ws://`) and prod (`wss://`) both work.
 */
export const createHaystackProvider = (deps: HaystackProviderDeps = {}): AgentProvider => {
  const managementClient = (settings: Settings) => makeManagementClient(settings, deps)

  return {
    id: haystackProviderId,
    list: async (request: Request, settings: Settings): Promise<RemoteAgentDescriptor[]> => {
      if (!isHaystackConfigured(settings)) {
        return []
      }
      try {
        const pipelines = await managementClient(settings).listPipelines()
        return pipelines
          .filter(
            // Deepset auto-idles pipelines (status flips DEPLOYED→IDLE), but they
            // wake on query — so key off the intended `desired_status`, not the
            // transient runtime status. Non-prompt pipelines (indexes) aren't chat
            // agents. Exclude our own `tb-*` deploys: those are user-owned and live
            // in the synced agents table, so listing them here too would double them.
            (p) =>
              (p.desired_status ?? p.status) === 'DEPLOYED' && p.supports_prompt !== false && !p.name.startsWith('tb-'),
          )
          .map((p) => ({
            id: p.name,
            name: p.name,
            type: 'managed-acp',
            transport: 'websocket',
            url: buildWebSocketUrl(request, `/haystack/ws?pipeline=${encodeURIComponent(p.name)}`),
            description: null,
            icon: null,
            isSystem: 1,
          }))
      } catch (err) {
        createStandaloneLogger(settings).warn({ err }, 'haystack list pipelines failed; returning empty')
        return []
      }
    },
    catalog: ({ settings }: ProviderContext): AgentDescriptor[] =>
      isDeployConfigured(settings) ? [haystackDescriptor] : [],
    deploy: async (spec: AgentSpec, { request, settings }: ProviderContext): Promise<DeployResponse> => {
      const name = typeof spec.name === 'string' ? spec.name : ''
      const ref = toPipelineRef(name)
      const client = managementClient(settings)
      // Clone the owner-curated template's YAML, create under our `tb-` namespace, then deploy.
      const queryYaml = await client.getPipelineYaml(settings.haystackTemplatePipeline)
      await client.createPipeline({ name: ref, queryYaml })
      const deployed = await client.deployPipeline(ref)
      // The chat endpoint is deterministic from the ref, so return it now — the
      // client persists the agent immediately without waiting for it to spin up.
      const connection: AgentConnection = {
        url: buildWebSocketUrl(request, `/haystack/ws?pipeline=${encodeURIComponent(ref)}`),
        transport: 'websocket',
      }
      return {
        deploymentId: encodeDeploymentId(haystackProviderId, ref),
        status: mapStatus(deployed.status),
        connection,
      }
    },
    status: async (ref: string, { request, settings }: ProviderContext): Promise<DeploymentStatusResponse> => {
      const deploymentId = encodeDeploymentId(haystackProviderId, ref)
      // A not-found pipeline was deleted/undeployed on the host — report `gone`
      // (a terminal state the client can warn on) rather than throwing.
      const pipeline = await managementClient(settings)
        .getPipeline(ref)
        .catch((err) => {
          if (err instanceof DeepsetManagementError && err.status === 404) {
            return null
          }
          throw err
        })
      if (!pipeline) {
        return { deploymentId, status: 'gone', detail: 'not found', connection: null }
      }
      const status = mapStatus(pipeline.status)
      // A usable (running, incl. auto-idled) pipeline carries the chat endpoint;
      // pending/failed/gone don't.
      const connection: AgentConnection | null =
        status === 'running'
          ? {
              url: buildWebSocketUrl(request, `/haystack/ws?pipeline=${encodeURIComponent(ref)}`),
              transport: 'websocket',
            }
          : null
      return { deploymentId, status, detail: pipeline.status, connection }
    },
  }
}
