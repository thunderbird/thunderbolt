/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readBoundedJson } from './request-body'

/** A streamed body that records how many chunks were pulled from it; chunked unless `headers` says otherwise. */
const createChunkedRequest = (chunks: Uint8Array[], headers?: HeadersInit) => {
  const state = { pulled: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (state.pulled === chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[state.pulled++])
    },
  })
  return { state, request: new Request('http://localhost/', { method: 'POST', body, headers }) }
}

/** `{"a":"xxxx…"}` split into `chunkCount` chunks, as a client without `Content-Length` would stream it. */
const jsonChunks = (chunkCount: number, chunkBytes: number) => {
  const text = `{"a":"${'x'.repeat(chunkCount * chunkBytes - 8)}"}`
  const bytes = new TextEncoder().encode(text)
  return Array.from({ length: chunkCount }, (_, i) => bytes.slice(i * chunkBytes, (i + 1) * chunkBytes))
}

describe('readBoundedJson', () => {
  it('parses a chunked body under the limit', async () => {
    const { request } = createChunkedRequest(jsonChunks(3, 10))
    expect(await readBoundedJson(request, 30)).toEqual({ ok: true, value: { a: 'x'.repeat(22) } })
  })

  it('stops reading a chunked body as soon as it crosses the limit', async () => {
    const { state, request } = createChunkedRequest(jsonChunks(1000, 10))
    expect(await readBoundedJson(request, 25)).toEqual({ ok: false, reason: 'too_large' })
    expect(state.pulled).toBeLessThan(10)
  })

  it('refuses a declared Content-Length over the limit without reading', async () => {
    const request = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Length': '31' },
      body: '{}',
    })
    expect(await readBoundedJson(request, 30)).toEqual({ ok: false, reason: 'too_large' })
    expect(request.bodyUsed).toBe(false)
  })

  it('still caps a stream that sends more than its Content-Length declared', async () => {
    const { state, request } = createChunkedRequest(jsonChunks(1000, 10), { 'Content-Length': '20' })
    expect(request.headers.get('content-length')).toBe('20')
    expect(await readBoundedJson(request, 25)).toEqual({ ok: false, reason: 'too_large' })
    expect(state.pulled).toBeLessThan(10)
  })

  it('reports a missing body, malformed JSON and invalid UTF-8 as invalid', async () => {
    const invalid = { ok: false, reason: 'invalid' } as const
    expect(await readBoundedJson(new Request('http://localhost/', { method: 'POST' }), 30)).toEqual(invalid)
    expect(await readBoundedJson(createChunkedRequest([new TextEncoder().encode('{nope')]).request, 30)).toEqual(
      invalid,
    )
    const badUtf8 = new Uint8Array([0x22, 0xff, 0x22])
    expect(await readBoundedJson(createChunkedRequest([badUtf8]).request, 30)).toEqual(invalid)
  })

  it('reports a body stream that fails mid-read as invalid', async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"a":'))
        controller.error(new Error('connection reset'))
      },
    })
    const request = new Request('http://localhost/', { method: 'POST', body })
    expect(await readBoundedJson(request, 30)).toEqual({ ok: false, reason: 'invalid' })
  })
})
