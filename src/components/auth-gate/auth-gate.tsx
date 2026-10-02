/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Navigate, Outlet, useLocation } from 'react-router'

import Loading from '@/loading'
import { useAuthGate, type AuthRequirement, type RedirectTarget } from './use-auth-gate'

type AuthGateProps = {
  /** What auth state is required to access child routes */
  require: AuthRequirement
}

const redirectPaths: Record<RedirectTarget, string> = {
  sso: '/sso-redirect',
  waitlist: '/waitlist',
  home: '/',
}

/**
 * Picks where an unauthenticated visitor goes, diverting a failed sign-in to the
 * terminal error page instead of the flow that just failed.
 *
 * SAML failures need this: `@better-auth/sso`'s assertion-consumer path
 * redirects to the flow's own `callbackURL` (the app root) and never reads
 * `onAPIError.errorURL`, so without the diversion the gate would send the user
 * straight back to the identity provider, forever.
 *
 * @param target - Where the gate wants to send this visitor
 * @param search - The current location's query string, including the leading `?`
 * @returns The path to navigate to
 */
export const resolveRedirect = (target: RedirectTarget, search: string): string => {
  if (target === 'sso' && new URLSearchParams(search).has('error')) {
    return `/auth-error${search}`
  }
  return redirectPaths[target]
}

/**
 * Route guard that controls access based on authentication state.
 * Use as a layout route element to wrap protected route groups.
 *
 * The gate decides redirect targets internally from `VITE_AUTH_MODE` and the
 * `VITE_AUTH_ENABLE_ANONYMOUS` / `VITE_BYPASS_WAITLIST` overlays — no caller
 * configuration needed.
 *
 * @example
 * // Require authentication — redirects to /sso-redirect (SSO mode) or /waitlist (consumer mode),
 * // or auto-creates an anonymous session when `VITE_AUTH_ENABLE_ANONYMOUS=true` on a bypass-waitlist
 * // / PR-preview deployment.
 * <Route element={<AuthGate require="authenticated" />}>
 *   <Route path="/" element={<Layout />} />
 * </Route>
 *
 * @example
 * // Require unauthenticated — redirects to / if already logged in.
 * <Route element={<AuthGate require="unauthenticated" />}>
 *   <Route path="waitlist" element={<WaitlistLayout />} />
 * </Route>
 */
export const AuthGate = ({ require }: AuthGateProps) => {
  const state = useAuthGate(require)
  const { search } = useLocation()

  if (state.status === 'loading') {
    return <Loading />
  }
  if (state.status === 'redirect') {
    return <Navigate to={resolveRedirect(state.target, search)} replace />
  }

  return <Outlet />
}
