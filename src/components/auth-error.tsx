/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { isSsoMode } from '@/lib/auth-mode'
import { useSearchParams } from 'react-router'

/**
 * Codes worth retrying. `state_mismatch` is the one to read carefully: Better
 * Auth sends it when the signed `state` cookie was missing or did not match,
 * which covers both a sign-in that outlived the cookie's five-minute lifetime
 * and a cross-site deployment that drops the cookie on every attempt. The copy
 * has to leave room for the second case.
 */
const retryableCodes = new Set([
  'invalid_state',
  'please_restart_the_process',
  'state_mismatch',
  'state_not_found',
  'state_security_mismatch',
])

/** Provider text is unbounded, so it is truncated before it reaches the page. */
const maxProviderMessageLength = 200

/**
 * Maps a Better Auth error code to copy that tells the user what to do next.
 * Unmapped codes get generic copy; the code is always rendered alongside it so a
 * support ticket carries the real signal even when the provider also sent a
 * description.
 */
const describeAuthError = (code: string): string => {
  if (retryableCodes.has(code)) {
    return 'Your sign-in did not finish in time, or this browser did not keep the sign-in cookie. Starting over usually fixes it. If it keeps happening, contact your administrator.'
  }
  if (code === 'account_not_linked') {
    return 'This email is already registered with a different sign-in method. Sign in the way you did originally, or contact your administrator.'
  }
  return 'Sign-in could not be completed. If this keeps happening, contact your administrator.'
}

/**
 * Normalizes the provider's `error_description`. Better Auth interpolates the
 * value straight into the redirect, so a provider that sent no description
 * arrives here as the literal string `undefined`.
 */
const readProviderMessage = (raw: string | null): string | null => {
  if (!raw || raw === 'undefined') {
    return null
  }
  return raw.slice(0, maxProviderMessageLength)
}

/**
 * Terminal landing page for auth failures, wired up as Better Auth's
 * `onAPIError.errorURL`. Deliberately does not re-enter the sign-in flow on
 * mount: a persistent failure (unlinked account, IdP misconfiguration) would
 * otherwise bounce between the app and the identity provider forever.
 */
const AuthError = () => {
  const [searchParams] = useSearchParams()
  // Better Auth reports the code as `?error=` on most paths, but a missing state
  // parameter arrives as `?state=state_not_found`.
  const code = searchParams.get('error') || searchParams.get('state') || 'unknown_error'
  // Anyone can craft this URL, and the text is the identity provider's, not
  // ours: attribute it so it never reads as a Thunderbolt instruction.
  const providerMessage = readProviderMessage(searchParams.get('error_description'))

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-8 px-6 text-center">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <AppLogo size={16} />
          <span>Thunderbolt</span>
        </div>

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Sign-in failed</h1>
          <p className="text-muted-foreground">{describeAuthError(code)}</p>
          {providerMessage && (
            <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
              Your identity provider reported: “{providerMessage}”
            </p>
          )}
          <p className="text-[length:var(--font-size-xs)] text-muted-foreground">Error code: {code}</p>
        </div>

        <Button onClick={() => window.location.replace(isSsoMode() ? '/sso-redirect' : '/')}>Try again</Button>
      </div>
    </div>
  )
}

export default AuthError
