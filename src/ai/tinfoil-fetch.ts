/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SecureClient } from 'tinfoil'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { appVersionHeader } from '@/lib/app-version'
import { handleAppVersionUnsupported } from '@/lib/app-version-unsupported'
import { handleSessionRejected } from '@/lib/session-rejected'
import { inferenceModelHeader } from '@shared/inference-usage'
import { isTinfoilTransportWedgedError } from './tinfoil-client'

/** Run an attested request and evict only transports whose internal state cannot be reused. */
export const fetchTinfoil = async (
  client: SecureClient,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  evictClient: () => void,
): Promise<Response> => {
  try {
    return await client.fetch(input, init)
  } catch (error) {
    if (isTinfoilTransportWedgedError(error)) {
      evictClient()
    }
    throw error
  }
}

/** Share managed authentication, version gating and session handling across confidential inference callers. */
export const createSystemTinfoilFetch =
  (
    client: SecureClient,
    model: string,
    evictClient: () => void,
    readAuthToken = getAuthToken,
    readSsoMode = isSsoMode,
  ) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = readAuthToken()
    const headers = new Headers(init?.headers)
    headers.set(inferenceModelHeader, model)
    for (const [key, value] of Object.entries(appVersionHeader())) {
      headers.set(key, value)
    }
    const upstreamInit: RequestInit = { ...init, headers }
    if (readSsoMode() && !token) {
      upstreamInit.credentials = 'include'
      headers.delete('authorization')
    } else if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    const response = await fetchTinfoil(client, input, upstreamInit, evictClient)
    handleAppVersionUnsupported(response.status)
    await handleSessionRejected(response)
    return response
  }
