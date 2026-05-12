/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthProvider } from './auth'

export type ReturnContext = 'onboarding' | 'integrations' | `/${string}`

const storageKey = 'oauth_flow_state'

/**
 * OAuth state stored in sessionStorage (device-local, survives page reload, dies with tab).
 * Never synced — PKCE verifiers and CSRF tokens are security-critical single-use values.
 */
type OAuthState = {
  state: string | null
  provider: OAuthProvider | null
  verifier: string | null
  returnContext: ReturnContext | null
}

/** Gets all OAuth flow state from sessionStorage. */
export const getOAuthState = (): OAuthState => {
  const raw = sessionStorage.getItem(storageKey)
  if (!raw) {
    return { state: null, provider: null, verifier: null, returnContext: null }
  }
  try {
    return JSON.parse(raw) as OAuthState
  } catch {
    return { state: null, provider: null, verifier: null, returnContext: null }
  }
}

/** Sets OAuth flow state in sessionStorage (merges with existing). */
export const setOAuthState = (update: Partial<OAuthState>): void => {
  const current = getOAuthState()
  const merged = { ...current, ...update }
  sessionStorage.setItem(storageKey, JSON.stringify(merged))
}

/** Clears all OAuth flow state from sessionStorage. */
export const clearOAuthState = (): void => {
  sessionStorage.removeItem(storageKey)
}
