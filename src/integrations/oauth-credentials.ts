/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, updateIntegrationCredentials } from '@/dal'
import { getDb } from '@/db/database'
import { refreshAccessToken, type OAuthProvider } from '@/lib/auth'
import type { HttpClient } from '@/lib/http'

export type OAuthCredentials = {
  access_token: string
  refresh_token?: string
  expires_at?: number
}

/**
 * Retrieve stored OAuth credentials for the given provider.
 * Throws if the integration has not been connected yet.
 */
export const getOAuthCredentials = async (provider: OAuthProvider): Promise<OAuthCredentials> => {
  const db = getDb()
  const row = await getIntegrationCredentials(db, provider)
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
  if (isTokenFresh(credentials.expires_at)) {
    return credentials.access_token
  }

  if (!credentials.refresh_token) {
    throw new Error('Access token expired and no refresh token available')
  }

  const newTokens = await refreshAccessToken(httpClient, provider, credentials.refresh_token)
  const updated: OAuthCredentials = {
    ...credentials,
    access_token: newTokens.access_token,
    expires_at: Date.now() + newTokens.expires_in * 1000,
  }

  const db = getDb()
  await updateIntegrationCredentials(db, provider, updated)

  return updated.access_token
}
