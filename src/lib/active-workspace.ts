/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getPersonalWorkspaceByOwner, getPersonalWorkspaceByOwnerQuery } from '@/dal'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getActiveUserId, useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'

/**
 * Best-effort match for the workspace id segment in URLs shaped like
 * `/w/<workspaceId>/...`. PR 3 introduces this routing; today no route uses
 * the `/w/...` prefix, so this is effectively a no-op feature flag — when the
 * routes land, this picks them up without further changes.
 */
const matchWorkspaceIdInPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/w\/([^/]+)/)
  return match?.[1] ?? null
}

/**
 * Resolve the active workspace id for the current user.
 *
 * Source of truth, in order:
 *   1. URL path (`/w/<id>/...`) — populated by PR 3's workspace selector.
 *   2. The user's personal workspace from the local DB.
 *
 * Returns `null` when there's no active user (caller is unauthenticated) or
 * the personal workspace hasn't been created yet (pre-bootstrap). Consumers
 * that require a workspace context should either await the bootstrap signal
 * (`<WorkspaceGate>`) or handle the null case explicitly.
 *
 * Async because the personal-workspace fallback hits SQLite. The lookup is a
 * single-row `SELECT` on an indexed column — <1ms locally.
 */
export const getActiveWorkspaceId = async (db: AnyDrizzleDatabase): Promise<string | null> => {
  const fromUrl = matchWorkspaceIdInPath(window.location.pathname ?? '')
  if (fromUrl) {
    return fromUrl
  }
  const userId = getActiveUserId()
  if (!userId) {
    return null
  }
  const personal = await getPersonalWorkspaceByOwner(db, userId)
  return personal?.id ?? null
}

/**
 * Non-React variant for code paths that require a workspace context and have
 * no recovery story for `null` — extension tools, AI pipeline entry points,
 * background jobs. Throws `Error('No active workspace')` instead of returning
 * null so callers can stay free of guard noise.
 *
 * Use `getActiveWorkspaceId(db)` if you can handle the null case yourself.
 */
export const requireActiveWorkspaceId = async (db: AnyDrizzleDatabase): Promise<string> => {
  const id = await getActiveWorkspaceId(db)
  if (!id) {
    throw new Error('No active workspace')
  }
  return id
}

/**
 * React subscriber for the active workspace id. Same resolution order as
 * `getActiveWorkspaceId`: URL prefix wins, otherwise the user's personal
 * workspace from a live query.
 *
 * Reads the active user id from the trust-domain registry (a Zustand store)
 * rather than from `useAuth()`/`useSession()` — the registry is mirrored from
 * Better Auth by `SessionToRegistryMirror` and is the canonical FE source of
 * "who is the user," same one `getActiveWorkspaceId(db)` uses. Sourcing from
 * the registry instead of an auth-context hook also means components rendered
 * outside `<AuthProvider>` (e.g. unit tests that mount only `<DatabaseProvider>`)
 * don't crash — the hook returns `null` until the registry has a user id.
 *
 * URL is read once from `window.location.pathname`; reactivity to URL changes
 * lands with PR 3's `/w/<id>` routing, at which point this hook should switch
 * to `useLocation()`.
 *
 * Components inside `<WorkspaceGate>` are guaranteed the personal workspace
 * exists, so the `null` is effectively only seen by the gate itself; everything
 * else can treat the value as eventually-non-null but should still guard React
 * Query with `enabled: !!workspaceId` to keep TypeScript honest.
 */
export const useActiveWorkspaceId = (): string | null => {
  const db = useDatabase()
  // Subscribe reactively to the registry so a sign-in mid-render flips the id.
  const userId = useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })

  const fromUrl = typeof window !== 'undefined' ? matchWorkspaceIdInPath(window.location.pathname) : null

  const { data } = useQuery({
    queryKey: ['workspaces', 'personal', userId],
    query: toCompilableQuery(getPersonalWorkspaceByOwnerQuery(db, userId ?? '')),
    enabled: !!userId,
  })

  if (fromUrl) {
    return fromUrl
  }
  if (!userId || !data || data.length === 0) {
    return null
  }
  return data[0].id
}
