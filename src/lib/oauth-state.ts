/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings, updateSettings, deleteSetting } from '@/dal'
import { getDb } from '@/db/database'
import type { OAuthProvider } from './auth'

export type ReturnContext = 'onboarding' | 'integrations' | `/${string}`

/**
 * OAuth state stored in sqlite settings
 */
type OAuthState = {
  state: string | null
  provider: OAuthProvider | null
  verifier: string | null
  returnContext: ReturnContext | null
}

/**
 * Gets all OAuth state from sqlite settings
 */
export const getOAuthState = async (): Promise<OAuthState> => {
  const db = getDb()
  const settings = await getSettings(db, {
    oauth_state: String,
    oauth_provider: String,
    oauth_verifier: String,
    oauth_return_context: String,
  })

  return {
    state: settings.oauthState,
    provider: settings.oauthProvider as OAuthProvider | null,
    verifier: settings.oauthVerifier,
    returnContext: settings.oauthReturnContext as ReturnContext | null,
  }
}

/**
 * Sets OAuth state in sqlite settings
 */
export const setOAuthState = async (state: Partial<OAuthState>): Promise<void> => {
  const settings: Record<string, string | null> = {}

  if (state.state !== undefined) {
    settings.oauth_state = state.state
  }
  if (state.provider !== undefined) {
    settings.oauth_provider = state.provider
  }
  if (state.verifier !== undefined) {
    settings.oauth_verifier = state.verifier
  }
  if (state.returnContext !== undefined) {
    settings.oauth_return_context = state.returnContext
  }

  if (Object.keys(settings).length > 0) {
    const db = getDb()
    await updateSettings(db, settings)
  }
}

/**
 * Clears OAuth state from sqlite settings
 */
export const clearOAuthState = async (): Promise<void> => {
  const db = getDb()
  await Promise.all([
    deleteSetting(db, 'oauth_state'),
    deleteSetting(db, 'oauth_provider'),
    deleteSetting(db, 'oauth_verifier'),
    deleteSetting(db, 'oauth_return_context'),
  ])
}
