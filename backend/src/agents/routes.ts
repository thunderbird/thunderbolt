import { getEnabledAgentIds, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import type { AgentDescriptor, AgentProvider } from './types'

/**
 * Creates the public agent discovery endpoint.
 *
 * Intentionally unauthenticated — returns metadata about enabled agents only
 * (no user-specific data). Clients need to discover available agents before
 * authenticating to use any of them. Reviewed and approved in PR #531.
 *
 * GET /agents — returns available agents, optionally filtered by type or id.
 */
export const createAgentsRoutes = (providers: AgentProvider[] = []) => {
  return new Elysia({ prefix: '/agents' }).onError(safeErrorHandler).get(
    '/',
    async ({ query }) => {
      const results = await Promise.allSettled(providers.map((p) => p.getAgents()))
      results
        .filter((r) => r.status === 'rejected')
        .forEach((r) => {
          console.error('[agents] Provider failed:', (r as PromiseRejectedResult).reason)
        })

      const enabledIds = getEnabledAgentIds(getSettings())
      const agents = results
        .filter((r): r is PromiseFulfilledResult<AgentDescriptor[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value)
        .filter((a) => !enabledIds || enabledIds.includes(a.id))
        .filter((a) => !query.type || a.type === query.type)
        .filter((a) => !query.id || a.id === query.id)

      return { agents }
    },
    {
      query: t.Object({
        type: t.Optional(t.String()),
        id: t.Optional(t.String()),
      }),
    },
  )
}
