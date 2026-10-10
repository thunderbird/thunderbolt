/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { buildAttachmentPart, type HydrationDeps } from '@/lib/attachments'
import { getChatErrorKind, getInferenceQuotaWindow } from '@/lib/error-utils'
import { createAuthenticatedClient, type HttpClient } from '@/lib/http'
import type { StoredFile } from '@/lib/file-blob-storage'
import { buildQuotePart } from '@/lib/quotes'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import { createManagedHttpAdapter, toManagedHttpBody } from './managed-http-adapter'

const hostedAgent: Agent = {
  id: 'hosted-agent',
  name: 'Assistant',
  type: 'managed-http',
  transport: 'http',
  url: '/v1/agent/chat',
  description: null,
  icon: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

const contextWith = (httpClient: HttpClient) => ({ httpClient }) as AgentAdapterContext

const chatBody = (text: string) =>
  JSON.stringify({
    id: 't1',
    trigger: 'submit-message',
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }],
  })

/** An authenticated client whose network is a stub that records the outgoing request. */
const recordingClient = (response: Response, backendUrl = 'http://localhost:8000/v1') => {
  const fetch = mock(async (_request: Request) => response)
  const client = createAuthenticatedClient(backendUrl, () => 'session-token', {
    fetch: fetch as unknown as typeof globalThis.fetch,
  })
  return { client, fetch }
}

const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
const originalPageUrl = window.location.href

// The app always runs on a real origin; happy-dom's default `about:blank` has none.
beforeEach(() => {
  window.location.href = 'https://app.example.com/chats/new'
  useLocalSettingsStore.setState({ cloudUrl: 'http://localhost:8000/v1' })
})

afterEach(() => {
  window.location.href = originalPageUrl
  useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
})

describe('createManagedHttpAdapter', () => {
  it('posts the chat body to the agent url through the authenticated client and returns the stream as is', async () => {
    const stream = new Response('data: {"type":"start"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    const { client, fetch } = recordingClient(stream)
    const controller = new AbortController()

    const response = await createManagedHttpAdapter(hostedAgent).fetch(
      { method: 'POST', body: chatBody('hello'), signal: controller.signal },
      contextWith(client),
    )

    expect(response).toBe(stream)
    const request = fetch.mock.calls[0]![0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe('http://localhost:8000/v1/agent/chat')
    expect(request.headers.get('Authorization')).toBe('Bearer session-token')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('X-App-Language')).toBeTruthy()
    expect(JSON.parse(await request.text())).toEqual(JSON.parse(chatBody('hello')))
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('resolves the agent path against a relative backend url', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '/v1' })
    const post = mock(async () => new Response('ok'))

    await createManagedHttpAdapter(hostedAgent).fetch(
      { method: 'POST', body: chatBody('hi') },
      contextWith({ post } as unknown as HttpClient),
    )

    expect((post.mock.calls[0] as unknown as [string])[0]).toBe('https://app.example.com/v1/agent/chat')
  })

  it('keeps a reverse-proxy prefix on the backend url, so the request still gets the app headers', async () => {
    const prefixedBackend = 'https://host.example/api/v1'
    useLocalSettingsStore.setState({ cloudUrl: prefixedBackend })
    const { client, fetch } = recordingClient(new Response('ok'), prefixedBackend)

    await createManagedHttpAdapter(hostedAgent).fetch({ method: 'POST', body: chatBody('hi') }, contextWith(client))

    const request = fetch.mock.calls[0]![0]
    expect(request.url).toBe('https://host.example/api/v1/agent/chat')
    // Set only on requests `createAuthenticatedClient` recognises as going to the backend.
    expect(request.headers.get('X-App-Language')).toBeTruthy()
  })

  it('serializes a rejected request so the chat error UI reads its status and quota window', async () => {
    const quotaBody = JSON.stringify({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
    const { client } = recordingClient(new Response(quotaBody, { status: 429 }))

    const response = await createManagedHttpAdapter(hostedAgent).fetch(
      { method: 'POST', body: chatBody('hi') },
      contextWith(client),
    )

    expect(response.status).toBe(429)
    // DefaultChatTransport throws the non-OK body text as the error message.
    const error = new Error(await response.text())
    expect(getInferenceQuotaWindow(error)).toBe('5h')
    expect(getChatErrorKind(error)).toBe('rate-limit')
  })

  it('lets a network failure propagate', async () => {
    const post = mock(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(
      createManagedHttpAdapter(hostedAgent).fetch(
        { method: 'POST', body: chatBody('hi') },
        contextWith({ post } as unknown as HttpClient),
      ),
    ).rejects.toThrow('Failed to fetch')
  })

  it('refuses an agent without a url', () => {
    expect(() => createManagedHttpAdapter({ ...hostedAgent, url: null })).toThrow('has no url')
  })
})

describe('toManagedHttpBody', () => {
  const textOnlyDeps: HydrationDeps = {
    getAttachment: async () => ({ blob: new Blob(['x']) }) as StoredFile,
    getTransformer: async () => async () => ({ text: 'EXTRACTED' }),
  }

  it('turns quotes and attachments into text and drops the parts the endpoint would reject', async () => {
    const body = JSON.stringify({
      id: 't1',
      trigger: 'submit-message',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [
            buildQuotePart({ text: 'quoted line' }),
            { type: 'text', text: 'about this' },
            buildAttachmentPart({
              localFileId: 'f1',
              filename: 'doc.pdf',
              mimeType: 'application/pdf',
              deliverAs: 'text',
            }),
            { type: 'data-widget', data: {} },
          ],
        },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            { type: 'source-url', sourceId: 's1', url: 'https://example.test' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    })

    const parsed = JSON.parse(await toManagedHttpBody(body, textOnlyDeps))

    expect(parsed.id).toBe('t1')
    expect(parsed.trigger).toBe('submit-message')
    expect(parsed.messages).toEqual([
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: '> quoted line' },
          { type: 'text', text: 'about this' },
          { type: 'text', text: '[Attachment: doc.pdf]\n\nEXTRACTED' },
        ],
      },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ])
  })
  it('drops file parts from assistant messages, which the endpoint accepts from the user only', async () => {
    const file = { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }
    const body = JSON.stringify({
      id: 't1',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look' }, file] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'here' }, file] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
      ],
    })

    const parsed = JSON.parse(await toManagedHttpBody(body, textOnlyDeps))

    expect(parsed.messages[0].parts).toEqual([{ type: 'text', text: 'look' }, file])
    expect(parsed.messages[1].parts).toEqual([{ type: 'text', text: 'here' }])
  })

  it('starts on a user message after filtering empties the leading turn', async () => {
    // The leading user turn's attachment is missing on this device, so filtering
    // empties it and the assistant reply after it would lead. A later assistant
    // turn held only a file, which assistants may not send, so it empties too.
    const missingFileDeps: HydrationDeps = { ...textOnlyDeps, getAttachment: async () => null }
    const body = JSON.stringify({
      id: 't1',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [buildAttachmentPart({ localFileId: 'gone', filename: 'a.pdf', mimeType: 'application/pdf' })],
        },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'got it' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'draw it' }] },
        {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }],
        },
        { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
      ],
    })

    const parsed = JSON.parse(await toManagedHttpBody(body, missingFileDeps))

    expect(parsed.messages.map((message: { id: string }) => message.id)).toEqual(['u2', 'u3'])
  })

  it('keeps the most recent 200 messages and starts the history on a user message', async () => {
    // 201 alternating messages, u0 … u200. The last 200 start on an assistant
    // message, so it is dropped too, leaving 199 that start and end on a user turn.
    const messages = Array.from({ length: 201 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `message ${index}` }],
    }))

    const parsed = JSON.parse(await toManagedHttpBody(JSON.stringify({ id: 't1', messages }), textOnlyDeps))

    expect(parsed.messages).toHaveLength(199)
    expect(parsed.messages[0]).toMatchObject({ id: 'm2', role: 'user' })
    expect(parsed.messages.at(-1)).toMatchObject({ id: 'm200', role: 'user' })
  })

  it('keeps a full 200 when the cut already lands on a user message', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      id: `m${index}`,
      role: 'user',
      parts: [{ type: 'text', text: `message ${index}` }],
    }))

    const parsed = JSON.parse(await toManagedHttpBody(JSON.stringify({ id: 't1', messages }), textOnlyDeps))

    expect(parsed.messages).toHaveLength(200)
    expect(parsed.messages[0].id).toBe('m50')
    expect(parsed.messages.at(-1).id).toBe('m249')
  })
})
