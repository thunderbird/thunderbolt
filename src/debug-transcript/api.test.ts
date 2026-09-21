/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createClient } from '@/lib/http'
import { submitDebugTranscript } from './api'
import type { DebugTranscriptPayloadV1 } from './types'

const payload: DebugTranscriptPayloadV1 = {
  schemaVersion: 1,
  capture: {
    capturedAt: '2026-08-17T18:00:00.000Z',
    appVersion: '1.2.3',
    platform: 'web',
    recorderDisabled: false,
  },
  identity: { userId: 'user-1', email: 'user@example.com' },
  thread: { threadId: 'thread-1' },
  turns: [],
}

describe('submitDebugTranscript', () => {
  it('posts the versioned payload to the authenticated relative route', async () => {
    const requests: Request[] = []
    const httpClient = createClient({
      prefixUrl: 'https://api.example.test/v1',
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({ id: 'transcript-1' }, { status: 201 })
      },
    })

    const result = await submitDebugTranscript(httpClient, {
      threadId: 'thread-1',
      payload,
      userNote: 'The second tool call failed.',
      clientVersion: '1.2.3',
    })

    expect(result).toEqual({ id: 'transcript-1' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example.test/v1/debug-transcripts')
    expect(requests[0]?.method).toBe('POST')
    expect(await requests[0]?.json()).toEqual({
      threadId: 'thread-1',
      schemaVersion: 1,
      payload,
      userNote: 'The second tool call failed.',
      clientVersion: '1.2.3',
    })
  })

  it('rejects when the backend responds with a non-2xx status', async () => {
    const httpClient = createClient({
      prefixUrl: 'https://api.example.test/v1',
      fetch: async () => Response.json({ error: 'payload rejected' }, { status: 413 }),
    })

    await expect(
      submitDebugTranscript(httpClient, {
        threadId: 'thread-1',
        payload,
      }),
    ).rejects.toThrow()
  })

  it('trims and sanitizes a user note without redacting ordinary token prose', async () => {
    const bodies: Array<{
      threadId: string
      schemaVersion: number
      payload: DebugTranscriptPayloadV1
      userNote?: string
    }> = []
    const httpClient = createClient({
      prefixUrl: 'https://api.example.test/v1',
      fetch: async (input, init) => {
        bodies.push(
          (await new Request(input, init).json()) as {
            threadId: string
            schemaVersion: number
            payload: DebugTranscriptPayloadV1
            userNote?: string
          },
        )
        return Response.json({ id: 'transcript-1' }, { status: 201 })
      },
    })

    await submitDebugTranscript(httpClient, {
      threadId: 'thread-1',
      payload,
      userNote: '  my token count looked wrong; Bearer abcdefghijklmnopqrstuvwxyz123456  ',
    })
    await submitDebugTranscript(httpClient, { threadId: 'thread-1', payload, userNote: '   ' })

    expect(bodies).toEqual([
      {
        threadId: 'thread-1',
        schemaVersion: 1,
        payload,
        userNote: 'my token count looked wrong; [redacted]',
      },
      { threadId: 'thread-1', schemaVersion: 1, payload },
    ])
  })
})
