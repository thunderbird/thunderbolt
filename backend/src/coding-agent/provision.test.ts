/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { provisionWorkspaceToken } from './provision'

type Captured = { url: string; method?: string; headers: Record<string, string> }

/** Programmable fetch: each step is an HTTP status, or 'throw'/'timeout' to reject. */
const makeFetch = (steps: Array<number | 'throw' | 'timeout'>) => {
  const calls: Captured[] = []
  let i = 0
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url: String(url), method: init?.method, headers })
    const step = steps[Math.min(i, steps.length - 1)]
    i += 1
    if (step === 'throw') {
      throw new Error('network down')
    }
    if (step === 'timeout') {
      const err = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    }
    return new Response(step === 200 ? 'ok' : '', { status: step })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const opts = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) => ({
  brokerUrl: 'https://broker.example/',
  serviceToken: 'svc-token',
  fetchFn,
  timeoutMs: 100,
  maxAttempts: 2,
  ...extra,
})

describe('provisionWorkspaceToken', () => {
  it('POSTs /github/provision with the service token + user id header (200 → ok, single call)', async () => {
    const { fetchFn, calls } = makeFetch([200])
    const result = await provisionWorkspaceToken(opts(fetchFn), 'user-alice')

    expect(result).toEqual({ status: 'ok' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://broker.example/github/provision') // trailing slash normalized
    expect(calls[0].headers.authorization).toBe('Bearer svc-token')
    expect(calls[0].headers['x-tb-user-id']).toBe('user-alice')
  })

  it('maps 409 to not_connected without retrying', async () => {
    const { fetchFn, calls } = makeFetch([409, 200])
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({ status: 'not_connected' })
    expect(calls).toHaveLength(1)
  })

  it('maps 501 to disabled without retrying', async () => {
    const { fetchFn, calls } = makeFetch([501, 200])
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({ status: 'disabled' })
    expect(calls).toHaveLength(1)
  })

  it('maps a non-retryable 4xx (401) to failed without retrying', async () => {
    const { fetchFn, calls } = makeFetch([401, 200])
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker 401' })
    expect(calls).toHaveLength(1)
  })

  it('retries a 5xx and fails after attempts are exhausted', async () => {
    const { fetchFn, calls } = makeFetch([500, 502])
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker 502' })
    expect(calls).toHaveLength(2)
  })

  it('retries a 5xx and succeeds on the second attempt', async () => {
    const { fetchFn, calls } = makeFetch([503, 200])
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({ status: 'ok' })
    expect(calls).toHaveLength(2)
  })

  it('retries a network error then fails as unreachable', async () => {
    const { fetchFn, calls } = makeFetch(['throw', 'throw'])
    expect(await provisionWorkspaceToken(opts(fetchFn), 'u1')).toEqual({
      status: 'failed',
      reason: 'broker unreachable',
    })
    expect(calls).toHaveLength(2)
  })

  it('maps a timeout to failed (broker timeout)', async () => {
    const { fetchFn } = makeFetch(['timeout'])
    expect(await provisionWorkspaceToken(opts(fetchFn, { maxAttempts: 1 }), 'u1')).toEqual({
      status: 'failed',
      reason: 'broker timeout',
    })
  })

  it('normalizes a broker URL with no trailing slash', async () => {
    const { fetchFn, calls } = makeFetch([200])
    await provisionWorkspaceToken(opts(fetchFn, { brokerUrl: 'https://broker.example' }), 'u1')
    expect(calls[0].url).toBe('https://broker.example/github/provision')
  })

  it('never carries the end-user Better-Auth token (only the service token)', async () => {
    const { fetchFn, calls } = makeFetch([200])
    await provisionWorkspaceToken(opts(fetchFn), 'u1')
    expect(calls[0].headers.authorization).toBe('Bearer svc-token')
  })
})
