/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { getEnabledAgentsList, getSettings, type Settings } from '@/config/settings'
import { createStandaloneLogger } from '@/config/logger'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { AgentDiscoveryResponse, RemoteAgentDescriptor } from '@shared/acp-types'
import {
  deployRequestSchema,
  schemaVersionMismatch,
  specSchemaForDescriptor,
  type AgentCatalogResponse,
  type AgentDescriptor,
  type AgentSpec,
  type DeployResponse,
  type DeploymentStatusResponse,
  type UndeployResponse,
} from '@shared/agent-descriptors'
import type { User } from '@shared/types/auth'
import { Elysia } from 'elysia'
import { decodeDeploymentId } from './deployment-id'
import { getProviderById, getRegisteredProviders, type ProviderContext } from './discovery'
import type { AgentsErrorResponse } from './types'

/** Generic error body for the deploy endpoints (may carry an app-specific `code`). */
type ErrorBody = { error: string; code?: string }

/**
 * Mounts `GET /agents`, the ACP discovery endpoint.
 *
 * - Unauthenticated → 401 `{ error: 'Unauthorized' }`
 * - Anonymous user → 403 `ANONYMOUS_DISCOVERY_FORBIDDEN` (anonymous sessions
 *   never see system agents; the FE falls back to the built-in only)
 * - Authenticated regular user → `AgentDiscoveryResponse`
 *
 * The agent list is built from {@link getRegisteredProviders}; the Haystack
 * module registers its provider into the same registry. `ENABLED_AGENTS` (comma-separated)
 * narrows the result. `ALLOW_CUSTOM_AGENTS` is echoed back so the UI can hide
 * "+ Add Custom Agent" per deployment.
 *
 * Settings are read on every request via {@link getSettings} so tests can
 * tweak env vars + `clearSettingsCache()` between cases.
 */
export const createAgentsRoutes = (auth: Auth) =>
  new Elysia({ name: 'agents-routes', prefix: '/agents' })
    .onError(safeErrorHandler)
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      // Better Auth populates session.user with `additionalFields` (including `isAnonymous`).
      const sessionUser = session?.user as User | undefined
      return { user: sessionUser ?? null }
    })
    .get(
      '/',
      async ({ request, set, user }): Promise<AgentDiscoveryResponse | AgentsErrorResponse | { error: string }> => {
        if (!user) {
          set.status = 401
          return { error: 'Unauthorized' }
        }
        if (user.isAnonymous) {
          set.status = 403
          return { error: 'Forbidden', code: 'ANONYMOUS_DISCOVERY_FORBIDDEN' }
        }

        const settings = getSettings()
        const enabledIds = getEnabledAgentsList(settings)
        const allowedById = (id: string) => enabledIds.length === 0 || enabledIds.includes(id)

        const agents = await collectAgents(request, settings)
        const filtered = agents.filter((descriptor) => allowedById(descriptor.id))

        return {
          version: '1',
          agents: filtered,
          allowCustomAgents: settings.allowCustomAgents,
        }
      },
    )
    .get('/catalog', async ({ request, set, user }): Promise<AgentCatalogResponse | ErrorBody> => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
      if (user.isAnonymous) {
        set.status = 403
        return { error: 'Forbidden', code: 'ANONYMOUS_DISCOVERY_FORBIDDEN' }
      }
      const settings = getSettings()
      if (!settings.agentDeploy) {
        set.status = 404
        return { error: 'Not found' }
      }
      return { version: '1', descriptors: collectCatalog({ request, settings, userId: user.id }) }
    })
    .post('/deploy', async ({ body, request, set, user }): Promise<DeployResponse | ErrorBody> => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
      if (user.isAnonymous) {
        set.status = 403
        return { error: 'Forbidden', code: 'ANONYMOUS_DISCOVERY_FORBIDDEN' }
      }
      const settings = getSettings()
      if (!settings.agentDeploy) {
        set.status = 404
        return { error: 'Not found' }
      }
      const parsed = deployRequestSchema.safeParse(body)
      if (!parsed.success) {
        set.status = 400
        return { error: 'Invalid deploy request' }
      }
      const ctx: ProviderContext = { request, settings, userId: user.id }
      const descriptor = collectCatalog(ctx).find((d) => d.id === parsed.data.descriptorId)
      if (!descriptor) {
        set.status = 404
        return { error: 'Unknown agent' }
      }
      // Reject a spec built against a stale descriptor before we act on it.
      if (descriptor.schemaVersion !== parsed.data.schemaVersion) {
        set.status = 409
        return { error: 'Schema version mismatch', code: schemaVersionMismatch }
      }
      const provider = getProviderById(descriptor.provider)
      if (!provider?.deploy) {
        set.status = 404
        return { error: 'Agent is not deployable' }
      }
      // Re-validate the spec server-side — the client is never trusted.
      const specResult = specSchemaForDescriptor(descriptor).safeParse(parsed.data.spec)
      if (!specResult.success) {
        set.status = 400
        return { error: 'Invalid spec' }
      }
      return provider.deploy(specResult.data as AgentSpec, ctx)
    })
    .get('/deployments/:id', async ({ params, request, set, user }): Promise<DeploymentStatusResponse | ErrorBody> => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
      if (user.isAnonymous) {
        set.status = 403
        return { error: 'Forbidden', code: 'ANONYMOUS_DISCOVERY_FORBIDDEN' }
      }
      const settings = getSettings()
      if (!settings.agentDeploy) {
        set.status = 404
        return { error: 'Not found' }
      }
      let decoded: { provider: string; ref: string }
      try {
        decoded = decodeDeploymentId(params.id)
      } catch {
        set.status = 400
        return { error: 'Invalid deployment id' }
      }
      const provider = getProviderById(decoded.provider)
      if (!provider?.status) {
        set.status = 404
        return { error: 'Unknown provider' }
      }
      return provider.status(decoded.ref, { request, settings, userId: user.id })
    })
    .delete('/deployments/:id', async ({ params, request, set, user }): Promise<UndeployResponse | ErrorBody> => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
      if (user.isAnonymous) {
        set.status = 403
        return { error: 'Forbidden', code: 'ANONYMOUS_DISCOVERY_FORBIDDEN' }
      }
      const settings = getSettings()
      if (!settings.agentDeploy) {
        set.status = 404
        return { error: 'Not found' }
      }
      let decoded: { provider: string; ref: string }
      try {
        decoded = decodeDeploymentId(params.id)
      } catch {
        set.status = 400
        return { error: 'Invalid deployment id' }
      }
      const provider = getProviderById(decoded.provider)
      if (!provider?.undeploy) {
        set.status = 404
        return { error: 'Unknown provider' }
      }
      return provider.undeploy(decoded.ref, { request, settings, userId: user.id })
    })

/**
 * Asks every registered provider for its descriptors and concatenates the
 * results. A throwing provider is logged and skipped — one misbehaving plugin
 * never poisons the response for the others.
 */
const collectAgents = async (request: Request, settings: Settings): Promise<RemoteAgentDescriptor[]> => {
  const log = createStandaloneLogger(settings)
  const out: RemoteAgentDescriptor[] = []
  for (const provider of getRegisteredProviders()) {
    try {
      out.push(...(await provider.list(request, settings)))
    } catch (error) {
      log.warn({ err: error, providerId: provider.id }, 'agent provider list() failed; skipping')
    }
  }
  return out
}

/**
 * Ask every deployable provider for its creation descriptors. Like
 * {@link collectAgents}, a throwing provider is logged and skipped so one bad
 * plugin never poisons the catalog.
 */
const collectCatalog = (ctx: ProviderContext): AgentDescriptor[] => {
  const log = createStandaloneLogger(ctx.settings)
  const out: AgentDescriptor[] = []
  for (const provider of getRegisteredProviders()) {
    if (!provider.catalog) {
      continue
    }
    try {
      out.push(...provider.catalog(ctx))
    } catch (error) {
      log.warn({ err: error, providerId: provider.id }, 'agent provider catalog() failed; skipping')
    }
  }
  return out
}
