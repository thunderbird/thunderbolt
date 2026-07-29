/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { RemoteAgentDescriptor } from '@shared/acp-types'
import type { AgentDescriptor, AgentSpec, DeployResponse, DeploymentStatusResponse } from '@shared/agent-descriptors'

/**
 * Everything a provider needs to service a catalog/deploy/status request: the
 * incoming request (WS URL host derivation), resolved settings, and the calling
 * user's id (deployment namespacing).
 */
export type ProviderContext = {
  request: Request
  settings: Settings
  userId: string
}

/**
 * An agent provider is the adapter for one agent "kind" (haystack/openclaw/…),
 * keyed by {@link AgentProvider.id}. It always contributes discovery descriptors
 * (`list`), and may optionally be *deployable* — exposing a creation `catalog`
 * plus `deploy`/`status` lifecycle verbs (THU-743). The Haystack module calls
 * {@link registerAgentProvider} at startup; future managed agents follow the same shape.
 */
export type AgentProvider = {
  /** Stable identifier for the provider. Re-registering the same id is a no-op.
   *  Matches `AgentDescriptor.provider`, so deploy requests route back here. */
  id: string
  /** Returns descriptors visible to the caller. May read settings or the request
   *  (e.g. for WS URL host derivation) and may be async (e.g. a live host query).
   *  Throwing / rejecting here is isolated per-provider — the discovery route
   *  swallows the failure and continues. */
  list: (request: Request, settings: Settings) => RemoteAgentDescriptor[] | Promise<RemoteAgentDescriptor[]>
  /** Curated creation descriptors (static). Absent → the provider is discovery-only
   *  and not deployable. */
  catalog?: (ctx: ProviderContext) => AgentDescriptor[]
  /** Create + deploy an instance from an already-validated spec. The returned
   *  `deploymentId` encodes `provider:ref` (see `deployment-id.ts`). */
  deploy?: (spec: AgentSpec, ctx: ProviderContext) => Promise<DeployResponse>
  /** Live deployment status for `ref`, fetched from the host — never stored. */
  status?: (ref: string, ctx: ProviderContext) => Promise<DeploymentStatusResponse>
}

/**
 * Module-level registry. Side-effectful by design: `createHaystackRoutes()`
 * calls {@link registerAgentProvider} as part of its construction, and the
 * discovery route reads back via {@link getRegisteredProviders}. Idempotent on
 * `id` so HMR / repeated test setup doesn't double-register.
 */
const providers: AgentProvider[] = []

/** Register an agent provider. Subsequent calls with the same `id` are skipped. */
export const registerAgentProvider = (provider: AgentProvider): void => {
  if (providers.some((p) => p.id === provider.id)) {
    return
  }
  providers.push(provider)
}

/** Return the current set of registered providers in registration order. */
export const getRegisteredProviders = (): AgentProvider[] => [...providers]

/** Look up a provider by id (its "kind"). Used to route deploy/status/catalog
 *  requests back to the owning provider. */
export const getProviderById = (id: string): AgentProvider | undefined => providers.find((p) => p.id === id)

/** Test helper — clears all providers. Not exported from the module index. */
export const resetAgentProvidersForTesting = (): void => {
  providers.length = 0
}

/**
 * Build a `wss://host/v1/<suffix>` URL from the incoming HTTP `Request`. Uses
 * `x-forwarded-proto` when present (deployed behind a reverse proxy) and falls
 * back to the request URL's protocol. Strips any leading slash from `suffix` to
 * keep call-sites unambiguous.
 *
 * Examples:
 *   buildWebSocketUrl(req, 'haystack/ws')
 *     => 'wss://thunderbolt.example/v1/haystack/ws'   (in prod behind TLS proxy)
 *     => 'ws://localhost:8000/v1/haystack/ws'         (local http dev)
 */
export const buildWebSocketUrl = (request: Request, suffix: string): string => {
  const url = new URL(request.url)
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const httpProto = forwardedProto || url.protocol.replace(':', '')
  const wsProto = httpProto === 'https' ? 'wss' : 'ws'
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || url.host
  const normalized = suffix.replace(/^\/+/, '')
  return `${wsProto}://${host}/v1/${normalized}`
}
