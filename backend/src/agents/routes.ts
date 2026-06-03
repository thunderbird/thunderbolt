/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { getEnabledAgentsList, getSettings, type Settings } from '@/config/settings'
import { createStandaloneLogger } from '@/config/logger'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { AgentDiscoveryResponse, RemoteAgentDescriptor } from '@shared/acp-types'
import type { User } from '@shared/types/auth'
import { Elysia } from 'elysia'
import { getRegisteredProviders } from './discovery'
import type { AgentsErrorResponse } from './types'

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
    .get('/', ({ request, set, user }): AgentDiscoveryResponse | AgentsErrorResponse | { error: string } => {
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

      const agents = collectAgents(request, settings)
      const filtered = agents.filter((descriptor) => allowedById(descriptor.id))

      return {
        version: '1',
        agents: filtered,
        allowCustomAgents: settings.allowCustomAgents,
      }
    })

/**
 * Asks every registered provider for its descriptors and concatenates the
 * results. A throwing provider is logged and skipped — one misbehaving plugin
 * never poisons the response for the others.
 */
const collectAgents = (request: Request, settings: Settings): RemoteAgentDescriptor[] => {
  const log = createStandaloneLogger(settings)
  const out: RemoteAgentDescriptor[] = []
  for (const provider of getRegisteredProviders()) {
    try {
      out.push(...provider.list(request, settings))
    } catch (error) {
      log.warn({ err: error, providerId: provider.id }, 'agent provider list() failed; skipping')
    }
  }
  return out
}
