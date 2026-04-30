/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Navigate, Outlet } from 'react-router'

import Loading from '@/loading'
import { useAuthGate, type AuthRequirement } from './use-auth-gate'

type AuthGateProps = {
  /** What auth state is required to access child routes */
  require: AuthRequirement
  /** Where to redirect when requirement is not met */
  redirectTo: string
}

/**
 * Route guard component that controls access based on authentication state.
 * Use as a layout route element to wrap protected route groups.
 *
 * @example
 * // Require authentication - redirect to /waitlist if not logged in
 * <Route element={<AuthGate require="authenticated" redirectTo="/waitlist" />}>
 *   <Route path="/" element={<Layout />} />
 * </Route>
 *
 * @example
 * // Require unauthenticated - redirect to / if already logged in
 * <Route element={<AuthGate require="unauthenticated" redirectTo="/" />}>
 *   <Route path="waitlist" element={<WaitlistLayout />} />
 * </Route>
 */
export const AuthGate = ({ require, redirectTo }: AuthGateProps) => {
  const state = useAuthGate(require)

  if (state.status === 'loading') {
    return <Loading />
  }
  if (state.status === 'redirect') {
    return <Navigate to={redirectTo} replace />
  }

  return <Outlet />
}
