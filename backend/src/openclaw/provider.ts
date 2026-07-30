/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentProvider, ProviderContext } from '@/agents'
import { buildWebSocketUrl, encodeDeploymentId } from '@/agents'
import type { Settings } from '@/config/settings'
import type { RemoteAgentDescriptor } from '@shared/acp-types'
import type {
  AgentConnection,
  AgentDescriptor,
  AgentSpec,
  DeploymentStatusResponse,
  DeployResponse,
  UndeployResponse,
} from '@shared/agent-descriptors'
import {
  deployOpenclawSandbox,
  killOpenclawSandboxForUser,
  openclawSandboxStatusForUser,
  type OpenclawE2bConfig,
  type OpenclawE2bDeps,
} from './e2b'

/**
 * Provider id registered into the agent discovery registry. Stable: the registry
 * dedupes on it and deploy requests route back here via `AgentDescriptor.provider`.
 */
export const openclawProviderId = 'openclaw'

/** The sandbox backend encoded in a deployment ref (`<backend>:<sandboxId>`). Only E2B for now. */
const e2bRefPrefix = 'e2b'

/** Version of {@link openclawDescriptor}; bump when its fields change. */
const openclawSchemaVersion = 1

/**
 * Curated one-click "Add agent" form for OpenClaw. Owner-managed: the backend
 * fixes the sandbox provider + model (env), so the only field is an optional
 * display name — which keeps it one-click-eligible (no required visible fields).
 */
const openclawDescriptor: AgentDescriptor = {
  id: openclawProviderId,
  provider: openclawProviderId,
  name: 'OpenClaw',
  description: 'Deploy a sandboxed OpenClaw coding agent.',
  icon: 'terminal',
  schemaVersion: openclawSchemaVersion,
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
          required: false,
          maxLength: 60,
          placeholder: 'OpenClaw',
          default: 'OpenClaw',
        },
      ],
    },
  ],
}

/** Whether OpenClaw is fully configured to deploy (E2B creds + model + inference key). */
const isOpenclawConfigured = (settings: Settings): boolean =>
  Boolean(settings.e2bApiKey && settings.openclawModel && settings.openclawOpenrouterApiKey)

/** Map settings onto the settings-agnostic E2B deploy config. */
const e2bConfig = (settings: Settings): OpenclawE2bConfig => ({
  apiKey: settings.e2bApiKey,
  model: settings.openclawModel,
  openrouterApiKey: settings.openclawOpenrouterApiKey,
})

/** Parse a deployment ref (`e2b:<sandboxId>`) to its sandbox id, or null if it isn't an E2B ref. */
export const parseSandboxRef = (ref: string): string | null => {
  const sep = ref.indexOf(':')
  if (sep <= 0) {
    return null
  }
  const sandboxId = ref.slice(sep + 1)
  return ref.slice(0, sep) === e2bRefPrefix && sandboxId ? sandboxId : null
}

/** The relay endpoint for a given ref — deterministic, so deploy can hand it back up front. */
const connectionFor = (request: Request, ref: string): AgentConnection => ({
  url: buildWebSocketUrl(request, `openclaw/ws?instance=${encodeURIComponent(ref)}`),
  transport: 'websocket',
})

/**
 * Build the OpenClaw provider. Unlike Haystack it's deploy-only: `list()` is
 * empty because a deployed instance is persisted to the synced `agents` table by
 * the client (so listing it here too would double it). `deploy` provisions a
 * per-user E2B sandbox and returns the relay URL immediately; `status` polls the
 * sandbox live (owner-gated) and never stores runtime state. `deps` injects a
 * fake E2B client in tests.
 */
export const createOpenclawProvider = (deps: OpenclawE2bDeps = {}): AgentProvider => ({
  id: openclawProviderId,
  list: (): RemoteAgentDescriptor[] => [],
  catalog: ({ settings }: ProviderContext): AgentDescriptor[] =>
    isOpenclawConfigured(settings) ? [openclawDescriptor] : [],
  deploy: async (_spec: AgentSpec, { request, settings, userId }: ProviderContext): Promise<DeployResponse> => {
    const sandbox = await deployOpenclawSandbox(userId, e2bConfig(settings), deps)
    const ref = `${e2bRefPrefix}:${sandbox.sandboxId}`
    // Return immediately with `pending` and the (deterministic) relay endpoint:
    // deploy no longer blocks on the ~15-30s boot, so the client persists the
    // agent up front and the status badge polls until ACP answers.
    return {
      deploymentId: encodeDeploymentId(openclawProviderId, ref),
      status: 'pending',
      connection: connectionFor(request, ref),
    }
  },
  status: async (ref: string, { request, settings, userId }: ProviderContext): Promise<DeploymentStatusResponse> => {
    const deploymentId = encodeDeploymentId(openclawProviderId, ref)
    const sandboxId = parseSandboxRef(ref)
    // Malformed ref → treat as gone (a terminal state the client warns on).
    if (!sandboxId) {
      return { deploymentId, status: 'gone', connection: null }
    }
    const status = await openclawSandboxStatusForUser(sandboxId, userId, settings.e2bApiKey, deps)
    // Only a usable (ACP-answering) sandbox carries the chat endpoint.
    const connection = status === 'running' ? connectionFor(request, ref) : null
    return { deploymentId, status, connection }
  },
  undeploy: async (ref: string, { settings, userId }: ProviderContext): Promise<UndeployResponse> => {
    const deploymentId = encodeDeploymentId(openclawProviderId, ref)
    const sandboxId = parseSandboxRef(ref)
    // Malformed ref, or a foreign / already-gone sandbox → idempotent no-op; the
    // owner-gated kill returns false without throwing, so the client still drops
    // its local row.
    if (sandboxId) {
      await killOpenclawSandboxForUser(sandboxId, userId, settings.e2bApiKey, deps)
    }
    return { deploymentId, status: 'gone' }
  },
})
