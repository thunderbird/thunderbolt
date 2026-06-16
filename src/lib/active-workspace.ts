/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  getPersonalWorkspaceByOwner,
  getPersonalWorkspaceByOwnerQuery,
  getWorkspaceByIdQuery,
  type Workspace,
} from '@/dal'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getActiveUserId, useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useCallback } from 'react'
import { useInRouterContext, useLocation, useNavigate, type NavigateOptions } from 'react-router'

/**
 * URL shape for shared workspaces: `/w/<workspaceId>/...`. The personal
 * workspace lives at unprefixed paths (`/chats/new`, `/settings/...`); only
 * shared workspaces appear in the URL. This deviates from addendum §3.5,
 * which mandates the prefix for every workspace — the deviation gives users
 * cleaner URLs for the common case (one personal workspace, no membership in
 * any shared one) without splitting the resolution rule (URL still wins when
 * present; the personal-workspace lookup is the fallback).
 */
const matchWorkspaceIdInPath = (pathname: string | undefined): string | null => {
  if (!pathname) {
    return null
  }
  const match = pathname.match(/^\/w\/([^/]+)/)
  return match?.[1] ?? null
}

/**
 * Strip the leading `/w/<id>` segment from a pathname, returning the bare
 * sub-path (always leading `/`). Used by the workspace selector to preserve
 * the current location when switching workspaces.
 */
export const stripWorkspacePrefix = (pathname: string): string => {
  const stripped = pathname.replace(/^\/w\/[^/]+/, '')
  return stripped.length > 0 ? stripped : '/'
}

/**
 * Build a navigable URL for a workspace + sub-path. Personal workspaces return
 * the sub-path unprefixed; shared workspaces get `/w/<id>` prepended. Passing
 * a path that already carries a workspace prefix is a no-op (defensive — the
 * sidebar's switch handler strips first, but other call sites may not).
 */
export const toWorkspaceUrl = (workspace: Workspace, path: string): string => {
  const subPath = path.startsWith('/w/') ? stripWorkspacePrefix(path) : path
  const normalized = subPath.startsWith('/') ? subPath : `/${subPath}`
  if (workspace.isPersonal === 1) {
    return normalized
  }
  return `/w/${workspace.id}${normalized}`
}

/**
 * Resolve the active workspace id for non-React callers (extension tools, AI
 * pipeline, background jobs). URL-first, personal-workspace fallback.
 *
 * Returns `null` when there's no active user (caller is unauthenticated) or
 * the personal workspace hasn't been created yet (pre-bootstrap). Consumers
 * that require a workspace context should either await the bootstrap signal
 * (`<WorkspaceGate>`) or handle the null case explicitly.
 *
 * Reads `window.location.pathname` directly because non-React callers don't
 * have access to React Router's context. The same URL-first rule that the
 * React hook applies still holds.
 */
export const getActiveWorkspaceId = async (db: AnyDrizzleDatabase): Promise<string | null> => {
  const fromUrl = typeof window !== 'undefined' ? matchWorkspaceIdInPath(window.location.pathname) : null
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
 */
export const requireActiveWorkspaceId = async (db: AnyDrizzleDatabase): Promise<string> => {
  const id = await getActiveWorkspaceId(db)
  if (!id) {
    throw new Error('No active workspace')
  }
  return id
}

/**
 * React subscriber for the active workspace row. URL prefix wins; personal
 * workspace is the fallback. Reactively re-runs on URL changes via
 * `useLocation()`, so navigation through `<Link>` / `navigate(...)` flips
 * consumers without a manual subscription.
 *
 * Reads the active user id from the trust-domain registry (a Zustand store)
 * rather than from `useAuth()` — the registry is mirrored from Better Auth by
 * `SessionToRegistryMirror` and is the canonical FE source of "who is the
 * user," same one `getActiveWorkspaceId(db)` uses. Sourcing from the registry
 * also means components rendered outside `<AuthProvider>` (e.g. unit tests
 * that mount only `<DatabaseProvider>`) don't crash — the hook returns `null`
 * until the registry has a user id.
 *
 * Returns `null` until both the user id and the workspace row are available.
 * Components inside `<WorkspaceGate>` are guaranteed the personal workspace
 * exists, so the `null` is effectively only seen by the gate itself; everything
 * else can treat the value as eventually-non-null but should still guard React
 * Query with `enabled: !!workspaceId` to keep TypeScript honest.
 */
/**
 * Reactive pathname inside a `<Router>` ancestor; a one-shot read of
 * `window.location.pathname` otherwise. The conditional hook call is safe
 * because `useInRouterContext()` returns a value stable for the lifetime of a
 * given mount — React's rules of hooks require consistent ordering across
 * renders of the same component, which this satisfies. Allowing the fallback
 * means hook consumers don't have to wrap every test in a `<MemoryRouter>`.
 */
const useReactivePathname = (): string => {
  const inRouter = useInRouterContext()
  if (!inRouter) {
    return typeof window !== 'undefined' ? window.location.pathname : '/'
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useLocation().pathname
}

export const useActiveWorkspace = (): Workspace | null => {
  const db = useDatabase()
  const pathname = useReactivePathname()
  const userId = useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })

  const fromUrl = matchWorkspaceIdInPath(pathname)
  // Single live query that switches target — keying on the lookup descriptor
  // means React Query treats by-id and personal as distinct queries with no
  // cross-render pollution. We always pass *some* query (Drizzle errors on
  // empty), and gate the consumer-visible result on `enabled` instead.
  const lookup = fromUrl ? { kind: 'by-id' as const, id: fromUrl } : { kind: 'personal' as const, userId }
  const query =
    lookup.kind === 'by-id'
      ? getWorkspaceByIdQuery(db, lookup.id)
      : getPersonalWorkspaceByOwnerQuery(db, lookup.userId ?? '')
  const enabled = lookup.kind === 'by-id' || !!lookup.userId

  const { data } = useQuery({
    queryKey:
      lookup.kind === 'by-id'
        ? ['workspaces', 'active', 'by-id', lookup.id]
        : ['workspaces', 'active', 'personal', lookup.userId ?? ''],
    query: toCompilableQuery(query),
    enabled,
  })

  return data?.[0] ?? null
}

/**
 * Convenience wrapper for the common case — just the id. URL-derived ids
 * surface IMMEDIATELY (without waiting for the local `workspaces` row to
 * materialize), keeping the hook in lockstep with the non-React
 * `getActiveWorkspaceId` async helper. The full `useActiveWorkspace()` row
 * is still loaded in the background for consumers that need name/icon/etc.
 *
 * For unprefixed paths (personal workspace), the id only resolves once the
 * row is in the local DB — `WorkspaceGate` is the upstream readiness barrier
 * so consumers inside it can treat the result as eventually-non-null.
 */
export const useActiveWorkspaceId = (): string | null => {
  const pathname = useReactivePathname()
  const fromUrl = matchWorkspaceIdInPath(pathname)
  const workspace = useActiveWorkspace()
  return fromUrl ?? workspace?.id ?? null
}

/**
 * Subpath to use when navigating BETWEEN workspaces (workspace selector swap
 * or `WorkspaceMembershipGate` redirect). Strips the `/w/<id>` prefix, then
 * collapses chat-detail paths to `/chats/new`: chat ids are per-workspace, so
 * carrying one across would land the user on Not Found in the target.
 */
export const crossWorkspaceSubPath = (pathname: string): string => {
  const subPath = stripWorkspacePrefix(pathname)
  if (/^\/chats(\/|$)/.test(subPath)) {
    return '/chats/new'
  }
  return subPath
}

/**
 * Build a URL for `path` in the active workspace. Returns `path` unchanged
 * when the active workspace is personal; prefixes `/w/<id>` for shared
 * workspaces. Returns `path` as-is during the brief window where the active
 * workspace hasn't resolved yet (rare — inside `<WorkspaceGate>` this is
 * effectively never the case).
 *
 * Use at every `navigate(...)` / `<Link to=...>` / `<NavLink to=...>` site
 * that should "follow the active workspace." For cross-workspace teleports
 * (e.g. the selector itself), use `toWorkspaceUrl(workspace, path)` directly
 * with the target workspace instead.
 */
/**
 * URL-only variant of `toWorkspaceUrl` used by the path-builder hooks. Mirrors
 * the rule that the canonical personal-workspace URL is unprefixed: when the
 * current pathname carries no `/w/<id>/` segment we treat the active workspace
 * as personal and return `path` unchanged, otherwise we re-prefix with the id
 * from the URL. Keeps the helpers DB-free so consumers can use them in tests
 * that don't wire `<DatabaseProvider>` / `<WorkspaceGate>`.
 */
const applyWorkspacePrefixFromUrl = (pathname: string, path: string): string => {
  const fromUrl = matchWorkspaceIdInPath(pathname)
  const subPath = path.startsWith('/w/') ? stripWorkspacePrefix(path) : path.startsWith('/') ? path : `/${path}`
  if (!fromUrl) {
    return subPath
  }
  return `/w/${fromUrl}${subPath}`
}

export const useWorkspaceUrl = (path: string): string => {
  const pathname = useReactivePathname()
  return applyWorkspacePrefixFromUrl(pathname, path)
}

/**
 * Workspace-aware `navigate` for event handlers. Returns a callback that
 * prefixes each navigation target with the active workspace (no-op for
 * personal). Use this anywhere a static `useWorkspaceUrl(...)` won't fit —
 * dynamic paths interpolating ids, conditionals at click time, etc.
 */
export const useWorkspaceNavigate = (): ((path: string, options?: NavigateOptions) => void) => {
  const navigate = useNavigate()
  const pathname = useReactivePathname()
  return useCallback(
    (path: string, options?: NavigateOptions) => {
      navigate(applyWorkspacePrefixFromUrl(pathname, path), options)
    },
    [navigate, pathname],
  )
}
