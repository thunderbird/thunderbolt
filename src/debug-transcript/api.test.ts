/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createClient } from '@/lib/http'
import { buildDebugTranscriptPayload } from './build-payload'
import { debugTranscriptNoteMaxLength } from '@shared/debug-transcript-contract'
import { buildDebugTranscriptRequest, submitDebugTranscript } from './api'
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

it('redacts free-text credentials in the real payload builder and outgoing note', async () => {
  const secrets = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const text = `Ordinary diagnostic context. -----BEGIN PRIVATE KEY-----\n${secrets[0]}\n-----END PRIVATE KEY----- aws_secret_access_key=${secrets[1]}; {"client_secret":"${secrets[2]}"} client_secret=#${secrets[2]}`
  const built = buildDebugTranscriptPayload({
    threadId: 'thread-1',
    authSession: null,
    appVersion: '1',
    platform: 'web',
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text }] },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text },
          {
            type: 'dynamic-tool',
            toolName: 'inspect',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { text },
            output: { text },
          },
        ],
      },
    ],
  })
  const bodies: string[] = []
  const httpClient = createClient({
    prefixUrl: 'https://api.example.test/v1',
    fetch: async (input, init) => {
      bodies.push(await new Request(input, init).text())
      return Response.json({ id: 'transcript-1' }, { status: 201 })
    },
  })
  await submitDebugTranscript(httpClient, { threadId: 'thread-1', payload: built, userNote: text })
  for (const secret of secrets) {
    expect(JSON.stringify(built).includes(secret)).toBe(false)
    expect(bodies[0]?.includes(secret)).toBe(false)
  }
  expect(built.turns[0]?.userPrompt.text).toContain('Ordinary diagnostic context.')
  expect(bodies[0]).toContain('Ordinary diagnostic context.')
})

it('redacts spaced credential labels through the payload builder and outgoing note', async () => {
  const secret = crypto.randomUUID()
  const text = `Ordinary context. Client Secret: ${secret} AWS Secret Access Key: ${secret}`
  const built = buildDebugTranscriptPayload({
    threadId: 'spaced',
    authSession: null,
    appVersion: '1',
    platform: 'web',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }],
  })
  const requests: Request[] = []
  const client = createClient({
    prefixUrl: 'https://api.example.test/v1',
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ id: 'spaced' }, { status: 201 })
    },
  })
  await submitDebugTranscript(client, { threadId: 'spaced', payload: built, userNote: text })
  expect(JSON.stringify(built).includes(secret)).toBe(false)
  const request = await requests[0]!.json()
  expect(request.userNote.includes(secret)).toBe(false)
  expect(request.userNote).toContain('Ordinary context.')
})

it('caps the sanitized note at the server limit and sends exactly the preview', async () => {
  const raw = 'client_secret=x '.repeat(81)
  expect(raw.length).toBe(1296)
  const preview = buildDebugTranscriptRequest({ threadId: 'thread-1', payload, userNote: raw })
  expect(preview.userNote!.length).toBeLessThanOrEqual(debugTranscriptNoteMaxLength)
  expect(preview.userNote).toBe('client_secret=[redacted] '.repeat(80).trimEnd())
  const requests: Request[] = []
  const client = createClient({
    prefixUrl: 'https://api.example.test/v1',
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ id: 'bounded' }, { status: 201 })
    },
  })
  await submitDebugTranscript(client, { threadId: 'thread-1', payload, userNote: raw })
  expect(await requests[0]!.json()).toEqual(preview)
})

it('redacts the complete note before cutting through a replacement at the limit', () => {
  const secret = crypto.randomUUID().slice(0, 6)
  const raw = 'a'.repeat(1978) + ` client_secret=${secret}`
  expect(raw.length).toBeLessThanOrEqual(debugTranscriptNoteMaxLength)
  const preview = buildDebugTranscriptRequest({ threadId: 'thread-1', payload, userNote: raw })
  expect(preview.userNote!.includes(secret)).toBe(false)
  expect(preview.userNote!.length).toBeLessThanOrEqual(debugTranscriptNoteMaxLength)
  expect(buildDebugTranscriptRequest(preview)).toEqual(preview)
})
