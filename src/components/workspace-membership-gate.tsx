/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getMembershipQuery } from '@/dal'
import Loading from '@/loading'
import { crossWorkspaceSubPath } from '@/lib/active-workspace'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation, useParams } from 'react-router'

/**
 * Grace window (ms) before redirecting an unmatched membership to the personal
 * workspace. Covers the legitimate "row hasn't synced down yet" case where a
 * freshly-invited user lands on a shared-workspace URL right after sync starts;
 * one second is enough for the PowerSync replication to materialize the row
 * but short enough that a genuinely non-member URL doesn't trap the user.
 */
const membershipGraceMs = 1000

/**
 * Route guard mounted under `/w/:workspaceId/...`. Verifies the active user has
 * a `workspace_memberships` row for the URL's workspace. Non-members get
 * redirected to the personal workspace (which lives at unprefixed paths in our
 * URL scheme — see `toWorkspaceUrl`); members fall through to the nested
 * routes.
 *
 * The live query is the primary signal. If a non-existent / non-member row
 * materializes mid-grace (sync just landed), the gate flips to the member
 * path without any redirect. Only after `membershipGraceMs` elapses does
 * the gate commit to the redirect — that's the "we waited, the row never
 * came" case.
 */
export const WorkspaceMembershipGate = () => {
  const db = useDatabase()
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const location = useLocation()
  const userId = useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })

  // Subscribe live: a membership row showing up via sync after the gate first
  // rendered should flip us to the member branch instantly.
  const { data: rows, isLoading } = useQuery({
    queryKey: ['workspace-memberships', workspaceId, userId],
    query: toCompilableQuery(getMembershipQuery(db, workspaceId ?? '', userId ?? '')),
    enabled: !!workspaceId && !!userId,
  })

  // Timer-with-cleanup is a legitimate `useEffect` per CLAUDE.md — there's no
  // render-time signal that "enough time has passed."
  const [graceElapsed, setGraceElapsed] = useState(false)
  useEffect(() => {
    setGraceElapsed(false)
    const handle = setTimeout(() => setGraceElapsed(true), membershipGraceMs)
    return () => clearTimeout(handle)
  }, [workspaceId, userId])

  // Guard preconditions: missing param/user means our caller wired routes wrong
  // or the registry hasn't hydrated; defer the decision to the upstream gates.
  if (!workspaceId || !userId) {
    return <Loading />
  }

  const hasMembership = !!rows && rows.length > 0

  if (hasMembership) {
    return <Outlet />
  }

  if (isLoading || !graceElapsed) {
    return <Loading />
  }

  // Drop the `/w/<id>` segment and forward to the personal workspace (the
  // unprefixed canonical URL). Chat ids are per-workspace, so a chat-detail
  // path is collapsed to `/chats/new` rather than landing on Not Found in
  // the personal workspace. Preserves search params (e.g. OAuth callback
  // context) so the user lands on the right place if they had one.
  const target = `${crossWorkspaceSubPath(location.pathname)}${location.search}`
  return <Navigate to={target} replace />
}
