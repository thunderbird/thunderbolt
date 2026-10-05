/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readBodyWithinLimit } from './request-body'

/** A streamed body that records how many chunks were pulled from it; chunked unless `headers` says otherwise. */
const createChunkedRequest = (chunkCount: number, chunkBytes: number, headers?: HeadersInit) => {
  const state = { pulled: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (state.pulled === chunkCount) {
        controller.close()
        return
      }
      state.pulled++
      controller.enqueue(new Uint8Array(chunkBytes).fill(120))
    },
  })
  return { state, request: new Request('http://localhost/', { method: 'POST', body, headers }) }
}

describe('readBodyWithinLimit', () => {
  it('returns the text of a chunked body under the limit', async () => {
    const { request } = createChunkedRequest(3, 10)
    expect(await readBodyWithinLimit(request, 30)).toBe('x'.repeat(30))
  })

  it('stops reading a chunked body as soon as it crosses the limit', async () => {
    const { state, request } = createChunkedRequest(1000, 10)
    expect(await readBodyWithinLimit(request, 25)).toBeNull()
    expect(state.pulled).toBeLessThan(10)
  })

  it('refuses a declared Content-Length over the limit without reading', async () => {
    const request = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Length': '31' },
      body: 'small',
    })
    expect(await readBodyWithinLimit(request, 30)).toBeNull()
    expect(request.bodyUsed).toBe(false)
  })

  it('still caps a stream that sends more than its Content-Length declared', async () => {
    const { state, request } = createChunkedRequest(1000, 10, { 'Content-Length': '20' })
    expect(request.headers.get('content-length')).toBe('20')
    expect(await readBodyWithinLimit(request, 25)).toBeNull()
    expect(state.pulled).toBeLessThan(10)
  })

  it('returns an empty string when there is no body', async () => {
    expect(await readBodyWithinLimit(new Request('http://localhost/', { method: 'POST' }), 30)).toBe('')
  })
})
