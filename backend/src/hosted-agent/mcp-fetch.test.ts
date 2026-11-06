/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createMcpFetch, McpResponseTooLargeError } from './mcp-fetch'

type FetchInit = Parameters<typeof fetch>[1]

/** A fetch answering with `respond`, which records each request's init. */
const stubFetch = (respond: (init?: FetchInit) => Promise<Response>) => {
  const inits: (FetchInit | undefined)[] = []
  const fetchFn = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: FetchInit) => {
      inits.push(init)
      return respond(init)
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return { fetchFn, inits }
}

/**
 * A body of `chunkCount` chunks of `chunkBytes` each, streamed without a length, that records what was read. It
 * queues nothing ahead, so every pull is a read.
 */
const createStreamedBody = (chunkCount: number, chunkBytes: number) => {
  const state = { pulled: 0, isCancelled: false }
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        if (state.pulled === chunkCount) {
          controller.close()
          return
        }
        state.pulled += 1
        controller.enqueue(new Uint8Array(chunkBytes).fill(120))
      },
      cancel: () => {
        state.isCancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { body, state }
}

/** Answers only by failing once the request is aborted, the way a server that never answers behaves. */
const neverAnswers = (init?: FetchInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })

const limits = { maxResponseBytes: 100, closeTimeoutMs: 50 }
const url = 'http://mcp.test/mcp'

describe('createMcpFetch', () => {
  it('passes a response within the cap through, with its status and headers', async () => {
    const { fetchFn } = stubFetch(async () =>
      Response.json({ ok: true }, { headers: { 'mcp-session-id': 'session-1' } }),
    )
    const response = await createMcpFetch(fetchFn, limits)(url, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBe('session-1')
    expect(await response.json()).toEqual({ ok: true })
  })

  it('refuses a response whose Content-Length is past the cap, without reading it', async () => {
    const { body, state } = createStreamedBody(10, 20)
    const { fetchFn } = stubFetch(async () => new Response(body, { headers: { 'content-length': '200' } }))
    await expect(createMcpFetch(fetchFn, limits)(url, { method: 'POST' })).rejects.toBeInstanceOf(
      McpResponseTooLargeError,
    )
    expect(state).toEqual({ pulled: 0, isCancelled: true })
  })

  it('cuts off a body streamed without a length once it crosses the cap', async () => {
    const { body, state } = createStreamedBody(1000, 30)
    const { fetchFn } = stubFetch(async () => new Response(body))
    const response = await createMcpFetch(fetchFn, limits)(url, { method: 'POST' })
    await expect(response.text()).rejects.toBeInstanceOf(McpResponseTooLargeError)
    expect(state.pulled).toBeLessThan(10)
  })

  it('gives up on a DELETE the server never answers once the close deadline passes', async () => {
    const { fetchFn } = stubFetch(neverAnswers)
    const started = performance.now()
    await expect(createMcpFetch(fetchFn, limits)(url, { method: 'DELETE' })).rejects.toThrow('timed out')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("keeps the caller's own signal on a DELETE", async () => {
    const { fetchFn } = stubFetch(neverAnswers)
    const caller = new AbortController()
    const closing = createMcpFetch(fetchFn, { ...limits, closeTimeoutMs: 10_000 })(url, {
      method: 'DELETE',
      signal: caller.signal,
    })
    caller.abort(new Error('The caller gave up'))
    await expect(closing).rejects.toThrow('The caller gave up')
  })

  it('gives no other request a deadline', async () => {
    const { fetchFn, inits } = stubFetch(async () => Response.json({}))
    await createMcpFetch(fetchFn, limits)(url, { method: 'POST' })
    expect(inits[0]?.signal).toBeUndefined()
  })
})
