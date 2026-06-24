/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { fetchAuthorizeUrl, fetchGithubStatus } from './github'

type Captured = { url: string; method?: string; headers: Record<string, string> }
type Step = number | 'throw' | 'timeout' | { status: number; body: string }

/** Programmable fetch: each step is an HTTP status (200 body inferred), an object
 *  with an explicit body, or 'throw'/'timeout' to reject. */
const makeFetch = (steps: Step[]) => {
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
    if (typeof step === 'object') {
      return new Response(step.body, { status: step.status })
    }
    return new Response(step === 200 ? '{}' : '', { status: step })
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

describe('fetchAuthorizeUrl', () => {
  it('GETs /github/authorize-url with the service token + user id, returns the url', async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 200, body: JSON.stringify({ url: 'https://github.com/login/oauth/authorize?x=1' }) },
    ])
    const result = await fetchAuthorizeUrl(opts(fetchFn), 'user-alice')

    expect(result).toEqual({ status: 'ok', url: 'https://github.com/login/oauth/authorize?x=1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://broker.example/github/authorize-url') // trailing slash normalized
    expect(calls[0].headers.authorization).toBe('Bearer svc-token')
    expect(calls[0].headers['x-tb-user-id']).toBe('user-alice')
  })

  it('maps 501 to disabled without retrying', async () => {
    const { fetchFn, calls } = makeFetch([501, 200])
    expect(await fetchAuthorizeUrl(opts(fetchFn), 'u1')).toEqual({ status: 'disabled' })
    expect(calls).toHaveLength(1)
  })

  it('maps a non-retryable 4xx to failed without retrying', async () => {
    const { fetchFn, calls } = makeFetch([403, 200])
    expect(await fetchAuthorizeUrl(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker 403' })
    expect(calls).toHaveLength(1)
  })

  it('retries a 5xx then succeeds', async () => {
    const { fetchFn, calls } = makeFetch([503, { status: 200, body: JSON.stringify({ url: 'https://x' }) }])
    expect(await fetchAuthorizeUrl(opts(fetchFn), 'u1')).toEqual({ status: 'ok', url: 'https://x' })
    expect(calls).toHaveLength(2)
  })

  it('treats a missing/empty url in the body as failed (bad body)', async () => {
    const { fetchFn } = makeFetch([{ status: 200, body: JSON.stringify({ url: '' }) }])
    expect(await fetchAuthorizeUrl(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker bad body' })
  })

  it('treats invalid JSON as failed (bad body)', async () => {
    const { fetchFn } = makeFetch([{ status: 200, body: 'not-json' }])
    expect(await fetchAuthorizeUrl(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker bad body' })
  })

  it('maps a timeout to failed', async () => {
    const { fetchFn } = makeFetch(['timeout'])
    expect(await fetchAuthorizeUrl(opts(fetchFn, { maxAttempts: 1 }), 'u1')).toEqual({
      status: 'failed',
      reason: 'broker timeout',
    })
  })

  it('retries a network error then fails as unreachable', async () => {
    const { fetchFn, calls } = makeFetch(['throw', 'throw'])
    expect(await fetchAuthorizeUrl(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker unreachable' })
    expect(calls).toHaveLength(2)
  })

  it('never carries an end-user token (only the service token)', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 200, body: JSON.stringify({ url: 'https://x' }) }])
    await fetchAuthorizeUrl(opts(fetchFn), 'u1')
    expect(calls[0].headers.authorization).toBe('Bearer svc-token')
  })
})

describe('fetchGithubStatus', () => {
  it('GETs /github/status and returns connected:true', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 200, body: JSON.stringify({ connected: true }) }])
    expect(await fetchGithubStatus(opts(fetchFn), 'u1')).toEqual({ status: 'ok', connected: true })
    expect(calls[0].url).toBe('https://broker.example/github/status')
    expect(calls[0].method).toBe('GET')
  })

  it('returns connected:false', async () => {
    const { fetchFn } = makeFetch([{ status: 200, body: JSON.stringify({ connected: false }) }])
    expect(await fetchGithubStatus(opts(fetchFn), 'u1')).toEqual({ status: 'ok', connected: false })
  })

  it('maps 501 to disabled', async () => {
    const { fetchFn } = makeFetch([501])
    expect(await fetchGithubStatus(opts(fetchFn), 'u1')).toEqual({ status: 'disabled' })
  })

  it('treats a non-boolean connected as failed (bad body)', async () => {
    const { fetchFn } = makeFetch([{ status: 200, body: JSON.stringify({ connected: 'yes' }) }])
    expect(await fetchGithubStatus(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker bad body' })
  })

  it('maps a 5xx after retries to failed', async () => {
    const { fetchFn, calls } = makeFetch([500, 500])
    expect(await fetchGithubStatus(opts(fetchFn), 'u1')).toEqual({ status: 'failed', reason: 'broker 500' })
    expect(calls).toHaveLength(2)
  })
})
