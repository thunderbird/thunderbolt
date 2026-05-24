/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const isSsoMode = () => import.meta.env.VITE_AUTH_MODE === 'sso'

/**
 * Returns true when anonymous-session auto-creation is enabled for this deployment.
 * Mirrors the operator-controlled overlay alongside the primary auth path (email-OTP or SSO).
 */
export const isAnonymousAuthEnabled = () => import.meta.env.VITE_AUTH_ENABLE_ANONYMOUS === 'true'

/**
 * Returns true when the waitlist gate is bypassed for this deployment
 */
export const isWaitlistBypassed = () => import.meta.env.VITE_BYPASS_WAITLIST === 'true'
