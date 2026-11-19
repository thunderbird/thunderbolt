/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { appVersionHeader } from './app-version'
import { setAuthToken } from './auth-token'
import { thunderboltCloudUrl } from './constants'
import {
  createIntegrationOAuthClient,
  getIntegrationRelayUrl,
  IntegrationOAuthRelayError,
  getIntegrationOAuthErrorMessage,
} from './integration-oauth-client'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

it('uses the official relay without changing standalone settings or sending app credentials', async () => {
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
  setAuthToken('unrelated-session')
  const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(request.url).toBe(`${thunderboltCloudUrl}/auth/google/config`)
    expect(request.headers.get('Authorization')).toBeNull()
    expect(request.headers.get('X-App-Version')).toBe(appVersionHeader()['X-App-Version'] ?? null)
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    return Response.json({ configured: true })
  })
  await createIntegrationOAuthClient(getIntegrationRelayUrl(), fetch).get('auth/google/config')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(useLocalSettingsStore.getState()).toMatchObject({ cloudUrl: '', localMode: true })
})

it('pins the relay and never forwards a different server’s session after server selection changes', async () => {
  useLocalSettingsStore.setState({ cloudUrl: 'https://original.example/v1' })
  setAuthToken('original-session')
  const requests: Request[] = []
  const client = createIntegrationOAuthClient(getIntegrationRelayUrl(), async (input, init) => {
    requests.push(new Request(input, init))
    return Response.json({})
  })
  await client.get('auth/microsoft/config')
  useLocalSettingsStore.setState({ cloudUrl: 'https://other.example/v1' })
  setAuthToken('other-session')
  await client.post('auth/microsoft/refresh', { json: { refresh_token: 'private-refresh' } })
  expect(requests[0].headers.get('Authorization')).toBe('Bearer original-session')
  expect(requests[0].credentials).toBe('include')
  expect(requests[1].url).toBe('https://original.example/v1/auth/microsoft/refresh')
  expect(requests[1].headers.get('Authorization')).toBeNull()
  expect(requests[1].credentials).toBe('omit')
})

it('distinguishes blocked networks from a relay requiring an app session', async () => {
  const networkError = new TypeError('NetworkError when attempting to fetch resource.')
  const offline = createIntegrationOAuthClient('https://relay.example/v1', async () => {
    throw networkError
  })
  await expect(offline.get('auth/google/config')).rejects.toMatchObject({ reason: 'unreachable', cause: networkError })
  const protectedRelay = createIntegrationOAuthClient(
    'https://relay.example/v1',
    async () => new Response('', { status: 401 }),
  )
  await expect(protectedRelay.get('auth/google/config')).rejects.toMatchObject({ reason: 'session-required' })
  expect(getIntegrationOAuthErrorMessage(new IntegrationOAuthRelayError('unreachable'))).not.toBeNull()
  expect(getIntegrationOAuthErrorMessage(new IntegrationOAuthRelayError('session-required'))).not.toBeNull()
  expect(getIntegrationOAuthErrorMessage(new Error('Provider error'))).toBeNull()
})
