/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentProvider, ProviderContext } from '@/agents'
import { buildWebSocketUrl, encodeDeploymentId } from '@/agents'
import { mintAgentInferenceToken } from '@/agents/inference-token'
import type { Settings } from '@/config/settings'
import { recordAgentDeployment, revokeAgentDeployment } from '@/dal'
import { db } from '@/db/client'
import { supportedModels } from '@/inference/routes'
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
 * Provider dependencies: the E2B seam ({@link OpenclawE2bDeps}) plus the DB and
 * token/deployment hooks. All optional so tests inject fakes without a real DB —
 * production falls back to the singletons. The DAL fns are typed structurally
 * (returning `PromiseLike`, which their Drizzle query builders satisfy) so a test
 * fake needs no cast.
 */
export type OpenclawProviderDeps = OpenclawE2bDeps & {
  database?: typeof db
  mintToken?: typeof mintAgentInferenceToken
  recordDeployment?: (database: typeof db, args: { deploymentId: string; userId: string }) => PromiseLike<unknown>
  revokeDeployment?: (database: typeof db, deploymentId: string) => PromiseLike<unknown>
}

/** A deploy targeting an unservable model — mapped to HTTP 400 by {@link safeErrorHandler}. */
class UnsupportedModelError extends Error {
  readonly status = 400
  constructor(model: string) {
    super(`Unsupported model: ${model || '(empty)'}`)
    this.name = 'UnsupportedModelError'
  }
}

/**
 * Provider id registered into the agent discovery registry. Stable: the registry
 * dedupes on it and deploy requests route back here via `AgentDescriptor.provider`.
 */
export const openclawProviderId = 'openclaw'

/** The sandbox backend encoded in a deployment ref (`<backend>:<sandboxId>`). Only E2B for now. */
const e2bRefPrefix = 'e2b'

/** Version of {@link openclawDescriptor}; bump when its fields change. */
const openclawSchemaVersion = 2

/**
 * Curated "Add agent" form for OpenClaw. Owner-managed sandbox: the backend fixes
 * the provider (E2B) and wires inference to our managed models, so the user picks
 * only a display name and which managed model to run. The `model` options are
 * resolved by the frontend from the `account-models` source (the same managed
 * catalog `/v1/chat/completions` serves), so the descriptor stays serverless of
 * the model list.
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
    {
      id: 'model',
      title: 'Choose a model',
      fields: [
        {
          key: 'model',
          label: 'Model',
          widget: 'select',
          required: true,
          source: { kind: 'fetched', sourceId: 'account-models' },
        },
      ],
    },
  ],
}

/** Whether OpenClaw can deploy: E2B creds + a reachable backend origin for the sandbox. */
const isOpenclawConfigured = (settings: Settings): boolean => Boolean(settings.e2bApiKey && settings.publicApiUrl)

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
export const createOpenclawProvider = (deps: OpenclawProviderDeps = {}): AgentProvider => ({
  id: openclawProviderId,
  list: (): RemoteAgentDescriptor[] => [],
  catalog: ({ settings }: ProviderContext): AgentDescriptor[] =>
    isOpenclawConfigured(settings) ? [openclawDescriptor] : [],
  deploy: async (spec: AgentSpec, { request, settings, userId }: ProviderContext): Promise<DeployResponse> => {
    const model = typeof spec.model === 'string' ? spec.model.trim() : ''
    // Reject anything we can't serve (empty, or a model outside the managed
    // catalog — e.g. GLM) before we ever create a sandbox.
    if (!(model in supportedModels)) {
      throw new UnsupportedModelError(model)
    }
    const database = deps.database ?? db
    const config: OpenclawE2bConfig = { apiKey: settings.e2bApiKey, publicApiUrl: settings.publicApiUrl, model }
    const deploymentIdFor = (sandboxId: string) =>
      encodeDeploymentId(openclawProviderId, `${e2bRefPrefix}:${sandboxId}`)
    const sandbox = await deployOpenclawSandbox(
      userId,
      config,
      {
        recordDeployment: async (sandboxId) => {
          await (deps.recordDeployment ?? recordAgentDeployment)(database, {
            deploymentId: deploymentIdFor(sandboxId),
            userId,
          })
        },
        mintToken: (sandboxId) =>
          (deps.mintToken ?? mintAgentInferenceToken)({
            userId,
            deploymentId: deploymentIdFor(sandboxId),
            expiresInSeconds: null,
          }),
      },
      deps,
    )
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
    // Malformed ref → nothing to revoke or kill (a garbage ref never named a real
    // deployment); idempotent no-op so the client still drops its local row.
    if (sandboxId) {
      // Revoke first — the token dies immediately even if the kill RPC lags, so a
      // torn-down sandbox can never keep spending against our managed inference.
      await (deps.revokeDeployment ?? revokeAgentDeployment)(deps.database ?? db, deploymentId)
      // Owner-gated: a foreign / already-gone sandbox returns false without throwing.
      await killOpenclawSandboxForUser(sandboxId, userId, settings.e2bApiKey, deps)
    }
    return { deploymentId, status: 'gone' }
  },
})
