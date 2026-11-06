/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { appVersionHeader } from './app-version'
import { getAuthToken } from './auth-token'
import { thunderboltCloudUrl } from './constants'
import { createClient } from './http'
import { nativeFetch } from './native-fetch'
import { isTauri } from './platform'
import { resolveAbsoluteBackendUrl } from './url-utils'
import { getLocalSetting } from '@/stores/local-settings-store'

/** Distinguishes relay reachability from an OAuth provider rejecting consent. */
export class IntegrationOAuthRelayError extends Error {
  constructor(
    readonly reason: 'unreachable' | 'session-required',
    cause?: unknown,
  ) {
    super(`Integration OAuth relay: ${reason}`, { cause })
    this.name = 'IntegrationOAuthRelayError'
  }
}

/** Resolves user-facing relay diagnostics at the display boundary. */
export const getIntegrationOAuthErrorMessage = (error: unknown) => {
  if (!(error instanceof IntegrationOAuthRelayError)) {
    return null
  }
  return error.reason === 'session-required'
    ? msg`This server requires Thunderbolt sign-in for Google and Microsoft. Standalone connections must be enabled on the server.`
    : msg`The sign-in service cannot be reached from this app. Check your connection; the server must also allow this app’s address.`
}

/** Standalone integrations use the official relay without selecting a cloud-sync server. */
export const getIntegrationRelayUrl = (): string =>
  resolveAbsoluteBackendUrl(getLocalSetting('cloudUrl') || thunderboltCloudUrl)

/** Pin OAuth traffic to its issuing relay, bypassing the general proxy and unrelated app credentials. */
export const createIntegrationOAuthClient = (
  relayUrl: string,
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = isTauri()
    ? nativeFetch
    : globalThis.fetch,
) => {
  const isSelectedServer = () => {
    const selected = getLocalSetting('cloudUrl')
    return Boolean(selected) && resolveAbsoluteBackendUrl(selected) === relayUrl
  }
  return createClient({
    prefixUrl: relayUrl,
    credentials: isSelectedServer() ? 'include' : 'omit',
    fetch: async (input, init) => {
      try {
        const response = await fetchFn(input, { ...init, redirect: 'error' })
        if (response.status === 401) {
          throw new IntegrationOAuthRelayError('session-required')
        }
        return response
      } catch (error) {
        if (error instanceof TypeError) {
          throw new IntegrationOAuthRelayError('unreachable', error)
        }
        throw error
      }
    },
    hooks: {
      beforeRequest: [
        (request) => {
          for (const [key, value] of Object.entries(appVersionHeader())) {
            request.headers.set(key, value)
          }
          if (isSelectedServer()) {
            const token = getAuthToken()
            if (token) {
              request.headers.set('Authorization', `Bearer ${token}`)
            }
          }
        },
      ],
    },
  })
}
