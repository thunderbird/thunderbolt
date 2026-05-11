/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Outlet } from 'react-router'

import Loading from '@/loading'
import { useAnonymousSessionGuard } from './use-anonymous-session-guard'

/**
 * Route guard that auto-creates an anonymous session when no session is present.
 * Use INSIDE the access gate (e.g. `AuthGate`) — it assumes the upstream gate
 * already decided this user is allowed in the app.
 *
 * @example
 * <Route element={<AuthGate require="authenticated" redirectTo="/waitlist" />}>
 *   <Route element={<AnonymousSessionGuard />}>
 *     <Route path="/" element={<Layout />} />
 *   </Route>
 * </Route>
 */
export const AnonymousSessionGuard = () => {
  const state = useAnonymousSessionGuard()
  if (state.status === 'loading') {
    return <Loading />
  }
  return <Outlet />
}
