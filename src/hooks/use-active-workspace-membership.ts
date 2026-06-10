/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getMembershipQuery, type WorkspaceMembership } from '@/dal'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'

export type ActiveWorkspaceMembership = {
  membership: WorkspaceMembership | null
  isAdmin: boolean
}

/**
 * Live `workspace_memberships` row for the active user × active workspace pair.
 * URL-driven (via `useActiveWorkspaceId`); reactively flips when the user
 * navigates between workspaces or a sync round-trip lands a new membership row.
 *
 * Returns `{ membership: null, isAdmin: false }` until both the workspace and
 * the user id resolve — consumers should treat that as "not yet known," not as
 * "definitively not a member." The same React Query key is used by
 * `WorkspaceMembershipGate` so the two share a single subscription.
 */
export const useActiveWorkspaceMembership = (): ActiveWorkspaceMembership => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const userId = useTrustDomainRegistry((state) => {
    if (state.activeTrustDomain?.kind === 'standalone') {
      return state.localUserId
    }
    if (state.activeTrustDomain?.kind === 'server') {
      return state.servers[state.activeTrustDomain.serverId]?.userId
    }
    return undefined
  })

  const { data } = useQuery({
    queryKey: ['workspace-memberships', workspaceId, userId],
    query: toCompilableQuery(getMembershipQuery(db, workspaceId ?? '', userId ?? '')),
    enabled: !!workspaceId && !!userId,
  })

  const membership = (data?.[0] ?? null) as WorkspaceMembership | null
  return {
    membership,
    isAdmin: membership?.role === 'admin',
  }
}
