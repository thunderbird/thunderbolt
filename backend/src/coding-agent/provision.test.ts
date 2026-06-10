/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { provisionWorkspaceToken } from './provision'

type Captured = { url: string; method?: string; headers: Record<string, string> }

const captureFetch = (status: number) => {
  const calls: Captured[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url: String(url), method: init?.method, headers })
    return new Response(status === 200 ? 'ok' : '', { status })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const opts = (fetchFn: typeof fetch) => ({
  brokerUrl: 'https://broker.example/',
  serviceToken: 'svc-token',
  fetchFn,
})

describe('provisionWorkspaceToken', () => {
  it('POSTs /github/provision with the service token + user id header', async () => {
    const { fetchFn, calls } = captureFetch(200)
    const result = await provisionWorkspaceToken(opts(fetchFn), 'user-alice')

    expect(result).toEqual({ status: 'ok' })
    expect(calls[0].method).toBe('POST')
    // base URL trailing slash is normalized
    expect(calls[0].url).toBe('https://broker.example/github/provision')
    expect(calls[0].headers.authorization).toBe('Bearer svc-token')
    expect(calls[0].headers['x-tb-user-id']).toBe('user-alice')
  })

  it('maps broker 409 to not_connected (dev must connect GitHub first)', async () => {
    const { fetchFn } = captureFetch(409)
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({ status: 'not_connected' })
  })

  it('maps other broker errors to failed with the status', async () => {
    for (const status of [401, 500, 501, 502]) {
      const { fetchFn } = captureFetch(status)
      expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({
        status: 'failed',
        reason: `broker ${status}`,
      })
    }
  })

  it('never carries the end-user Better-Auth token (only the service token)', async () => {
    const { fetchFn, calls } = captureFetch(200)
    await provisionWorkspaceToken(opts(fetchFn), 'u1')
    expect(calls[0].headers.authorization).toBe('Bearer svc-token')
  })
})
