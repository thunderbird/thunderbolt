/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, updateIntegrationCredentials } from '@/dal'
import { getDb } from '@/db/database'
import { refreshAccessToken, type OAuthProvider } from '@/lib/auth'
import { createIntegrationOAuthClient } from '@/lib/integration-oauth-client'
import type { HttpClient } from '@/lib/http'
import { getIdentitySignal } from '@/lib/identity-lifetime'

export type OAuthCredentials = {
  oauthRelayUrl?: string
  sessionRevision?: string
  access_token: string
  refresh_token?: string
  expires_at?: number
}

/**
 * Retrieve stored OAuth credentials for the given provider.
 * Throws if the integration has not been connected yet.
 */
export const getOAuthCredentials = async (provider: OAuthProvider): Promise<OAuthCredentials> => {
  const signal = getIdentitySignal()
  const db = getDb()
  const row = await getIntegrationCredentials(db, provider)
  signal.throwIfAborted()
  if (!row) {
    throw new Error(`${provider} integration not connected`)
  }
  return row.credentials
}

/**
 * Check whether a token is still valid with a 60-second safety buffer.
 * Returns true when the token can be reused without refreshing.
 */
export const isTokenFresh = (expiresAt: number | undefined, now: number = Date.now()): boolean =>
  expiresAt !== undefined && expiresAt - 60_000 > now

/**
 * Ensure that we have a valid OAuth access token, refreshing it if necessary.
 * If refreshed, the stored credentials are updated automatically.
 */
export const ensureValidOAuthToken = async (
  httpClient: HttpClient,
  provider: OAuthProvider,
  credentials: OAuthCredentials,
): Promise<string> => {
  const signal = getIdentitySignal()
  return navigator.locks.request(`integration-oauth:${provider}`, async () => {
    signal.throwIfAborted()
    const db = getDb()
    const row = await getIntegrationCredentials(db, provider)
    signal.throwIfAborted()
    // Another window may have refreshed while this request waited, or the user may have switched accounts.
    if (!row?.enabled || row.credentials.sessionRevision !== credentials.sessionRevision) {
      throw new Error('The integration changed before token refresh. Try again.')
    }
    const current = row.credentials
    if (isTokenFresh(current.expires_at)) {
      return current.access_token
    }

    if (!current.refresh_token) {
      throw new Error('Access token expired and no refresh token available')
    }

    const relayClient = current.oauthRelayUrl ? createIntegrationOAuthClient(current.oauthRelayUrl) : httpClient
    const newTokens = await refreshAccessToken(relayClient, provider, current.refresh_token, signal)
    signal.throwIfAborted()
    const updated: OAuthCredentials = {
      ...current,
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token || current.refresh_token,
      expires_at: Date.now() + newTokens.expires_in * 1000,
    }

    await db.transaction(async (tx) => {
      signal.throwIfAborted()
      await updateIntegrationCredentials(tx, provider, updated, current)
      signal.throwIfAborted()
    })
    signal.throwIfAborted()

    return updated.access_token
  })
}
