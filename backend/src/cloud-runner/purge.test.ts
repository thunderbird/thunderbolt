/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the cloud runner purge call. `fetchFn` is injected per case
 * (backend/docs/testing.md) — the global `fetch` throws in tests, so any
 * un-injected call surfaces immediately. The account-deletion integration
 * (ordering vs. the DB delete, failure logging) lives in `api/account.test.ts`.
 */

import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import { cloudRunnerHttpOrigin, purgeCloudRunnerData } from './purge'

type PurgeCall = { url: string; authorization: string | undefined }

const captureFetch = (
  calls: PurgeCall[],
  responder: (attempt: number) => Response | Promise<Response>,
): typeof fetch => {
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input.toString(), authorization: (init?.headers as Record<string, string>)?.authorization })
    return responder(calls.length)
  }
  return Object.assign(impl, { preconnect: () => {} }) as unknown as typeof fetch
}

const purge = (cloudRunnerWsUrl: string, fetchFn: typeof fetch, authorization: string | null = 'Bearer user-token') =>
  purgeCloudRunnerData({ settings: createTestSettings({ cloudRunnerWsUrl }), authorization, fetchFn })

describe('cloudRunnerHttpOrigin', () => {
  it('maps wss to https and ws to http', () => {
    expect(cloudRunnerHttpOrigin('wss://runner.example/')).toBe('https://runner.example')
    expect(cloudRunnerHttpOrigin('ws://runner.example/')).toBe('http://runner.example')
  })

  it('preserves a non-default port', () => {
    expect(cloudRunnerHttpOrigin('ws://localhost:8787')).toBe('http://localhost:8787')
  })

  it('drops path, query, and hash', () => {
    expect(cloudRunnerHttpOrigin('wss://runner.example/acp?x=1#f')).toBe('https://runner.example')
  })

  it('passes an http(s) URL through to its own origin', () => {
    expect(cloudRunnerHttpOrigin('https://runner.example/acp')).toBe('https://runner.example')
  })

  it('throws on a URL without a scheme', () => {
    expect(() => cloudRunnerHttpOrigin('runner.example')).toThrow()
  })
})

describe('purgeCloudRunnerData', () => {
  it('does not call the runner when no runner is configured', async () => {
    const calls: PurgeCall[] = []
    expect(
      await purge(
        '',
        captureFetch(calls, () => new Response(null, { status: 204 })),
      ),
    ).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('POSTs /purge on the derived origin with the forwarded bearer', async () => {
    const calls: PurgeCall[] = []
    const failure = await purge(
      'wss://runner.example/',
      captureFetch(calls, () => new Response(null, { status: 204 })),
    )

    expect(failure).toBeNull()
    expect(calls).toEqual([{ url: 'https://runner.example/purge', authorization: 'Bearer user-token' }])
  })

  it('reports a failure without calling the runner when the bearer is absent', async () => {
    const calls: PurgeCall[] = []
    const failure = await purge(
      'wss://runner.example/',
      captureFetch(calls, () => new Response(null, { status: 204 })),
      null,
    )

    expect(failure).toBe('missing authorization header')
    expect(calls).toHaveLength(0)
  })

  it('retries once and succeeds when the first attempt fails', async () => {
    const calls: PurgeCall[] = []
    const failure = await purge(
      'wss://runner.example/',
      captureFetch(calls, (attempt) => new Response(null, { status: attempt === 1 ? 503 : 204 })),
    )

    expect(failure).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('reports the status after both attempts fail', async () => {
    const calls: PurgeCall[] = []
    const failure = await purge(
      'wss://runner.example/',
      captureFetch(calls, () => new Response(null, { status: 401 })),
    )

    expect(failure).toBe('status 401')
    expect(calls).toHaveLength(2)
  })

  it('reports the error name when the runner is unreachable', async () => {
    const calls: PurgeCall[] = []
    const failure = await purge(
      'wss://runner.example/',
      captureFetch(calls, () => Promise.reject(new DOMException('timed out', 'TimeoutError'))),
    )

    expect(failure).toBe('TimeoutError')
    expect(calls).toHaveLength(2)
  })

  it('reports a failure instead of throwing when the configured URL is malformed', async () => {
    const calls: PurgeCall[] = []
    const failure = await purge(
      'runner.example',
      captureFetch(calls, () => new Response(null, { status: 204 })),
    )

    expect(failure).toBe('TypeError')
    expect(calls).toHaveLength(0)
  })
})
