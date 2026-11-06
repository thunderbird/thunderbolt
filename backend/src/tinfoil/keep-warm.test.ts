/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createTinfoilKeepWarm, type TinfoilKeepWarmLogger } from './keep-warm'
import { createTinfoilUpstreamOriginStore } from './upstream-origin'

const tinfoilSettings = {
  tinfoilApiKey: 'test-tinfoil-key',
  tinfoilEnclaveUrl: 'https://inference.tinfoil.sh/v1',
}

const createLogger = () => {
  const entries: Array<{ context: Record<string, unknown>; message: string }> = []
  const logger: TinfoilKeepWarmLogger = {
    debug: (context, message) => entries.push({ context, message }),
  }

  return { entries, logger }
}

describe('createTinfoilKeepWarm', () => {
  it('probes the configured default before traffic, repeats, and stops cleanly', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { logger } = createLogger()
    const keepWarm = createTinfoilKeepWarm(tinfoilSettings, {
      fetchFn,
      intervalMs: 5,
      logger,
      upstreamOriginStore: createTinfoilUpstreamOriginStore(),
    })

    keepWarm.start()
    try {
      expect(requests).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(requests.length).toBeGreaterThan(1)
    } finally {
      keepWarm.stop()
    }

    const requestCountAfterStop = requests.length
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(requests).toHaveLength(requestCountAfterStop)
    const firstRequest = requests[0]
    expect(firstRequest?.input.toString()).toBe('https://inference.tinfoil.sh/v1/models')
    expect(firstRequest?.init?.method).toBe('GET')
    expect(new Headers(firstRequest?.init?.headers).get('authorization')).toBe('Bearer test-tinfoil-key')
  })

  it('probes the latest upstream origin while preserving the configured API prefix', () => {
    const requests: Array<RequestInfo | URL> = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      requests.push(input)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const upstreamOriginStore = createTinfoilUpstreamOriginStore()
    upstreamOriginStore.record('https://router.inf6.tinfoil.sh/v1/chat/completions?stream=true')
    const { logger } = createLogger()
    const keepWarm = createTinfoilKeepWarm(tinfoilSettings, {
      fetchFn,
      intervalMs: 100,
      logger,
      upstreamOriginStore,
    })

    keepWarm.start()
    keepWarm.stop()

    expect(upstreamOriginStore.get()).toBe('https://router.inf6.tinfoil.sh')
    expect(requests[0]?.toString()).toBe('https://router.inf6.tinfoil.sh/v1/models')
  })

  it('does not start without an API key', async () => {
    const requests: Array<RequestInfo | URL> = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      requests.push(input)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { logger } = createLogger()
    const keepWarm = createTinfoilKeepWarm(
      { ...tinfoilSettings, tinfoilApiKey: '' },
      { fetchFn, intervalMs: 1, logger },
    )

    keepWarm.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    keepWarm.stop()

    expect(requests).toHaveLength(0)
  })

  it('resumes probing after start, stop, and start', () => {
    const requests: Array<RequestInfo | URL> = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      requests.push(input)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { logger } = createLogger()
    const keepWarm = createTinfoilKeepWarm(tinfoilSettings, {
      fetchFn,
      intervalMs: 100,
      logger,
    })

    keepWarm.start()
    expect(requests).toHaveLength(1)
    keepWarm.stop()
    keepWarm.start()

    try {
      expect(requests).toHaveLength(2)
    } finally {
      keepWarm.stop()
    }
  })

  it('times out failed probes, logs only safe metadata, and ignores the failure', async () => {
    const aborted = Promise.withResolvers<unknown>()
    const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal

      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => {
          aborted.resolve(signal.reason)
          reject(signal.reason)
        }
        signal.addEventListener('abort', rejectOnAbort, { once: true })
        if (signal.aborted) {
          rejectOnAbort()
        }
      })
    }) as unknown as typeof fetch
    const { entries, logger } = createLogger()
    const keepWarm = createTinfoilKeepWarm(tinfoilSettings, {
      fetchFn,
      intervalMs: 100,
      timeoutMs: 1,
      logger,
    })

    keepWarm.start()
    try {
      expect(await aborted.promise).toBeInstanceOf(DOMException)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      keepWarm.stop()
    }

    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      context: { errorName: 'TimeoutError' },
      message: 'Tinfoil enclave keep-warm request failed',
    })
    expect(JSON.stringify(entries)).not.toContain(tinfoilSettings.tinfoilApiKey)
  })
})
