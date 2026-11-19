/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'

/** Managed SSO builds stay pinned; generic clients discover the chosen server's sign-in flow. */
export const resolveSsoMode = (authMode: AppConfig['authMode'], buildMode = import.meta.env.VITE_AUTH_MODE): boolean =>
  buildMode === 'sso' || authMode === 'oidc' || authMode === 'saml'

/** Read the active server's authentication mode, with support for older servers. */
export const isSsoMode = () => resolveSsoMode(useConfigStore.getState().config.authMode)

/**
 * Returns true when anonymous-session auto-creation is enabled for this deployment.
 * Mirrors the operator-controlled overlay alongside the primary auth path (email-OTP or SSO).
 */
export const isAnonymousAuthEnabled = () =>
  useConfigStore.getState().config.authAllowAnonymous ?? import.meta.env.VITE_AUTH_ENABLE_ANONYMOUS === 'true'

/**
 * Returns true when the waitlist gate is bypassed for this deployment
 */
export const isWaitlistBypassed = () => import.meta.env.VITE_BYPASS_WAITLIST === 'true'

/**
 * Returns true when anonymous sign-in must first solve an ALTCHA challenge.
 * Has to match the API's CAPTCHA_PROVIDER, which refuses unsolved sign-ins when set to `altcha`.
 */
export const isAltchaCaptchaEnabled = () =>
  (useConfigStore.getState().config.captchaProvider ?? import.meta.env.VITE_CAPTCHA_PROVIDER) === 'altcha'
