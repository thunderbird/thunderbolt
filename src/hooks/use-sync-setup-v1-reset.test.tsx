/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { createClient, type HttpClient } from '@/lib/http'
import { useSyncSetup } from './use-sync-setup'

const deviceIdKey = 'thunderbolt_device_id'

/** Metadata shape the backend serves for a v1 beta account (pre-v2 row). */
const v1Metadata = {
  canary_iv: 'aXY=',
  canary_ctext: 'Y3Q=',
  signing_public_key: null,
  kdf_salt: null,
  key_version: 1,
  primary_key_id: '0',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type RouteHandler = (request: Request) => Response

/** Route-aware mock HTTP boundary: `"METHOD /v1/path" → handler`, recording every call. */
const createRoutedHttpClient = (routes: Record<string, RouteHandler>) => {
  const calls: string[] = []
  const httpClient = createClient({
    prefixUrl: 'http://test-api.local/v1',
    fetch: async (request) => {
      const req = request as Request
      const key = `${req.method} ${new URL(req.url).pathname}`
      calls.push(key)
      const handler = routes[key]
      if (!handler) {
        return json({ error: `no route for ${key}` }, 500)
      }
      return handler(req)
    },
  })
  return { httpClient, calls }
}

const renderSyncSetup = (httpClient: HttpClient) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
  )
  return renderHook(() => useSyncSetup(), { wrapper })
}

const deleteKeyDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

describe('useSyncSetup v1 beta reset (G3)', () => {
  beforeEach(async () => {
    localStorage.setItem(deviceIdKey, 'test-device-id')
    await deleteKeyDatabase()
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
  })

  it('detects a v1 account, resets it, and routes into fresh v2 first-device setup', async () => {
    const { httpClient, calls } = createRoutedHttpClient({
      'POST /v1/devices': () => json({ trusted: false }),
      'GET /v1/encryption/canary': () => json(v1Metadata),
      'POST /v1/encryption/reset': () => new Response(null, { status: 204 }),
    })
    const { result } = renderSyncSetup(httpClient)

    let intro: Awaited<ReturnType<typeof result.current.continueIntro>>
    await act(async () => {
      intro = await result.current.continueIntro()
    })

    expect(intro!).toBe('v1-account')
    expect(result.current.step).toBe('v1-reset')

    await act(async () => {
      await result.current.continueV1Reset()
    })

    expect(calls).toContain('POST /v1/encryption/reset')
    expect(calls.filter((call) => call === 'POST /v1/devices')).toHaveLength(2)
    expect(result.current.step).toBe('first-device-setup')
    expect(result.current.error).toBeNull()
  })

  it('never attempts an envelope unwrap for a v1 account, even when the device row is still trusted', async () => {
    const { httpClient, calls } = createRoutedHttpClient({
      'POST /v1/devices': () => json({ trusted: true, envelope: 'stale-v1-envelope' }),
      'GET /v1/encryption/canary': () => json(v1Metadata),
    })
    const { result } = renderSyncSetup(httpClient)

    await act(async () => {
      await result.current.continueIntro()
    })

    expect(result.current.step).toBe('v1-reset')
    expect(calls).not.toContain('GET /v1/devices/me/envelope')
  })

  it('treats a 409 from the reset endpoint as "actually v2" and falls back to the approval flow', async () => {
    const { httpClient } = createRoutedHttpClient({
      'POST /v1/devices': () => json({ trusted: false }),
      'GET /v1/encryption/canary': () => json(v1Metadata),
      'POST /v1/encryption/reset': () => json({ error: 'Account is already on encryption v2' }, 409),
    })
    const { result } = renderSyncSetup(httpClient)

    await act(async () => {
      await result.current.continueIntro()
    })
    expect(result.current.step).toBe('v1-reset')

    await act(async () => {
      await result.current.continueV1Reset()
    })

    expect(result.current.step).toBe('approval-waiting')
  })

  it('surfaces a non-409 reset failure on the v1-reset step for retry', async () => {
    const { httpClient } = createRoutedHttpClient({
      'POST /v1/devices': () => json({ trusted: false }),
      'GET /v1/encryption/canary': () => json(v1Metadata),
      'POST /v1/encryption/reset': () => json({ error: 'boom' }, 500),
    })
    const { result } = renderSyncSetup(httpClient)

    await act(async () => {
      await result.current.continueIntro()
    })

    await act(async () => {
      await result.current.continueV1Reset()
    })

    expect(result.current.step).toBe('v1-reset')
    expect(result.current.error).not.toBeNull()
  })

  it('routes a v2 account to the additional-device flow', async () => {
    const { httpClient } = createRoutedHttpClient({
      'POST /v1/devices': () => json({ trusted: false }),
      'GET /v1/encryption/canary': () => json({ ...v1Metadata, signing_public_key: 'c3BraQ==', kdf_salt: 'c2FsdA==' }),
    })
    const { result } = renderSyncSetup(httpClient)

    let intro: Awaited<ReturnType<typeof result.current.continueIntro>>
    await act(async () => {
      intro = await result.current.continueIntro()
    })

    expect(intro!).toBe('additional-device')
    expect(result.current.step).toBe('approval-waiting')
  })

  it('routes a fresh account (no metadata) to first-device setup', async () => {
    const { httpClient } = createRoutedHttpClient({
      'POST /v1/devices': () => json({ trusted: false }),
      'GET /v1/encryption/canary': () => json({ error: 'not set up' }, 404),
    })
    const { result } = renderSyncSetup(httpClient)

    let intro: Awaited<ReturnType<typeof result.current.continueIntro>>
    await act(async () => {
      intro = await result.current.continueIntro()
    })

    expect(intro!).toBe('first-device')
    expect(result.current.step).toBe('first-device-setup')
  })
})
