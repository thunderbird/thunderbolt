/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { BlockedUrlError, TooManyRedirectsError } from '@/utils/url-validation'
import { contentName, fetchOk, isRetryable, PermanentDownloadError, readCapped } from './download'

/** A body streamed in the given chunks, pulled only when read, recording whether the reader cancelled it. */
const streamed = (chunks: string[], headers: Record<string, string> = {}) => {
  const state = { cancelled: false, pulled: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        const chunk = chunks[state.pulled]
        state.pulled += 1
        if (chunk === undefined) {
          controller.close()
          return
        }
        controller.enqueue(new TextEncoder().encode(chunk))
      },
      cancel: () => {
        state.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { response: new Response(body, { headers }), state }
}

describe('readCapped', () => {
  it('reads a body within the limit', async () => {
    const { response } = streamed(['ab', 'cd'])

    expect(new TextDecoder().decode(await readCapped(response, 4))).toBe('abcd')
  })

  it('refuses an oversized body from Content-Length without reading it', async () => {
    const { response, state } = streamed(['abcde'], { 'content-length': '5' })

    await expect(readCapped(response, 4)).rejects.toThrow('larger than the 4-byte limit')
    expect(state.pulled).toBe(0)
    expect(state.cancelled).toBe(true)
  })

  it('stops streaming once a body passes the limit', async () => {
    const { response, state } = streamed(['abc', 'def', 'ghi'])

    await expect(readCapped(response, 4)).rejects.toThrow('larger than the 4-byte limit')
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBe(2)
  })
})

describe('contentName', () => {
  it('names a file by the first 16 bytes of its SHA-256', async () => {
    const name = await contentName(new TextEncoder().encode('abc'), 'woff2')

    expect(name).toBe('ba7816bf8f01cfea414140de5dae2223.woff2')
  })
})

describe('fetchOk', () => {
  const answering = (status: number) => async () => new Response('body', { status })

  it('returns an ok response', async () => {
    expect((await fetchOk('https://acme.test/x', answering(200))).status).toBe(200)
  })

  it('treats a 4xx as final, except the ones that ask to come back later', async () => {
    await expect(fetchOk('https://acme.test/x', answering(404))).rejects.toBeInstanceOf(PermanentDownloadError)
    for (const status of [408, 429, 500, 503]) {
      const error = await fetchOk('https://acme.test/x', answering(status)).catch((thrown: unknown) => thrown)
      expect(isRetryable(error)).toBe(true)
    }
  })
})

describe('isRetryable', () => {
  it('retries network trouble but not a refused URL, a redirect loop or a configuration problem', () => {
    expect(isRetryable(new Error('connection reset'))).toBe(true)
    expect(isRetryable(new PermanentDownloadError('too large'))).toBe(false)
    expect(isRetryable(new BlockedUrlError('private address'))).toBe(false)
    expect(isRetryable(new TooManyRedirectsError('loop'))).toBe(false)
  })
})
