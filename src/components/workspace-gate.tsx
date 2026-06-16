/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useDatabase } from '@/contexts'
import { getPersonalWorkspaceByOwnerQuery } from '@/dal'
import Loading from '@/loading'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { Outlet } from 'react-router'

/**
 * Renders main-app routes only once the user's personal workspace exists in
 * the local DB — the signal that `runPostAuthBootstrap` has completed its
 * FE-local create. Until then we show the boot splash; without this gate,
 * components could mount and fire DAL inserts with a null workspace id
 * (`getActiveWorkspaceId` resolves through the personal-workspace lookup, so
 * the row's existence is the readiness invariant).
 *
 * Auth-flow routes (login, waitlist, OAuth/magic-link callbacks) sit OUTSIDE
 * this gate — they don't need a workspace.
 */
export const WorkspaceGate = () => {
  const db = useDatabase()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const userId = session?.user?.id

  // Live query: the existence of the personal workspace row IS the bootstrap
  // signal. PowerSync re-runs this when the row appears (sync download or
  // FE-create) and the gate flips automatically.
  //
  // The gate sits inside `<AuthGate require="authenticated">` so `userId`
  // should always be defined when this mounts, but we guard with `enabled`
  // anyway to avoid hardcoding the assumption.
  const { data } = useQuery({
    queryKey: ['workspaces', 'personal', userId],
    query: toCompilableQuery(getPersonalWorkspaceByOwnerQuery(db, userId ?? '')),
    enabled: !!userId,
  })

  if (!userId || !data || data.length === 0) {
    return <Loading />
  }

  return <Outlet />
}
