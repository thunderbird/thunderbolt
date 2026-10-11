/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { buildAttachmentPart } from '@/lib/attachments'
import { getChatErrorKind, getInferenceQuotaWindow, isAgentRunInProgressError } from '@/lib/error-utils'
import { createAuthenticatedClient, type HttpClient } from '@/lib/http'
import { buildQuotePart } from '@/lib/quotes'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createSpyHttpClient } from '@/test-utils/http-client-spy'
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

const userMessage = (text: string, id = 'u1') => ({
  id,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text }],
})

const chatBody = (text: string) =>
  JSON.stringify({ id: 't1', trigger: 'submit-message', messages: [userMessage(text)] })

/** An authenticated client whose network is a stub that records the outgoing request. */
const recordingClient = (response: Response, backendUrl = 'http://localhost:8000/v1') => {
  const fetch = mock(async (_request: Request) => response)
  const client = createAuthenticatedClient(backendUrl, () => 'session-token', {
    fetch: fetch as unknown as typeof globalThis.fetch,
  })
  return { client, fetch }
}

/** Run one turn through the adapter and return the body it posted. */
const postedBody = async (body: string) => {
  const { httpClient, fetchSpy } = createSpyHttpClient(async () => new Response('ok'))
  await createManagedHttpAdapter(hostedAgent).fetch({ method: 'POST', body }, contextWith(httpClient))
  return JSON.parse(await (fetchSpy.mock.calls[0]![0] as Request).text())
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
  it('posts the chat as JSON to the agent url through the authenticated client and returns the stream as is', async () => {
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
    expect(JSON.parse(await request.text())).toEqual({ id: 't1', messages: [userMessage('hello')] })
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('resolves the agent path against a relative backend url', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '/v1' })
    const { httpClient, fetchSpy } = createSpyHttpClient(async () => new Response('ok'))

    await createManagedHttpAdapter(hostedAgent).fetch({ method: 'POST', body: chatBody('hi') }, contextWith(httpClient))

    expect((fetchSpy.mock.calls[0]![0] as Request).url).toBe('https://app.example.com/v1/agent/chat')
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

  it.each(['.evil.com/x', '@evil.com/x', '//evil.com/x', 'https://evil.com/x'])(
    'refuses an agent url %p that would leave the backend, before sending anything',
    async (url) => {
      const { httpClient, fetchSpy } = createSpyHttpClient()

      await expect(
        createManagedHttpAdapter({ ...hostedAgent, url }).fetch(
          { method: 'POST', body: chatBody('hi') },
          contextWith(httpClient),
        ),
      ).rejects.toThrow('server-relative path')
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it('refuses a server-relative url outside the backend api, before sending anything', async () => {
    const { httpClient, fetchSpy } = createSpyHttpClient()

    await expect(
      createManagedHttpAdapter({ ...hostedAgent, url: '/admin/export' }).fetch(
        { method: 'POST', body: chatBody('hi') },
        contextWith(httpClient),
      ),
    ).rejects.toThrow('does not resolve to the backend')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a body that is not a string, like the sibling adapters', async () => {
    const { httpClient } = createSpyHttpClient()

    await expect(
      createManagedHttpAdapter(hostedAgent).fetch({ method: 'POST', body: new Blob(['{}']) }, contextWith(httpClient)),
    ).rejects.toThrow('expects string body')
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
    expect(isAgentRunInProgressError(error)).toBe(false)
  })

  it('serializes a run already in progress so the chat can tell it apart and retry later', async () => {
    const busyBody = JSON.stringify({ error: { code: 'AGENT_RUN_IN_PROGRESS' } })
    const { client } = recordingClient(new Response(busyBody, { status: 429 }))

    const response = await createManagedHttpAdapter(hostedAgent).fetch(
      { method: 'POST', body: chatBody('hi') },
      contextWith(client),
    )

    expect(isAgentRunInProgressError(new Error(await response.text()))).toBe(true)
  })

  it('lets a network failure propagate', async () => {
    const { httpClient } = createSpyHttpClient(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(
      createManagedHttpAdapter(hostedAgent).fetch({ method: 'POST', body: chatBody('hi') }, contextWith(httpClient)),
    ).rejects.toThrow('Failed to fetch')
  })

  it('refuses an agent without a url', () => {
    expect(() => createManagedHttpAdapter({ ...hostedAgent, url: null })).toThrow('has no url')
  })

  it('never sends message metadata, which is an encrypted column', async () => {
    const body = JSON.stringify({
      id: 't1',
      trigger: 'submit-message',
      messageId: 'm-regenerate',
      messages: [
        {
          ...userMessage('hi'),
          metadata: { mcpTools: [{ name: 'local-files', url: 'http://127.0.0.1:9000' }], usage: { totalTokens: 9 } },
        },
      ],
    })

    const posted = await postedBody(body)

    expect(posted).toEqual({ id: 't1', messages: [userMessage('hi')] })
    expect(JSON.stringify(posted)).not.toContain('local-files')
  })

  it('sends no file from the history and notes each turn that had some, once per turn', async () => {
    // A chat that switched to the hosted agent after files were attached.
    const body = JSON.stringify({
      id: 't1',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [
            { type: 'text', text: 'compare these' },
            buildAttachmentPart({ localFileId: 'f1', filename: 'scan.pdf', mimeType: 'application/pdf' }),
            { type: 'file', mediaType: 'image/png', filename: 'chart.png', url: 'data:image/png;base64,AA==' },
          ],
        },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
        userMessage('thanks', 'u2'),
      ],
    })

    const posted = await postedBody(body)

    expect(JSON.stringify(posted)).not.toContain('"type":"file"')
    expect(posted.messages[0]).toEqual({
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: 'compare these' },
        {
          type: 'text',
          text: [
            '[Attachment "scan.pdf" could not be delivered to this agent]',
            '[Attachment "chart.png" could not be delivered to this agent]',
          ].join('\n'),
        },
      ],
    })
    expect(posted.messages.slice(1)).toEqual([
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
      userMessage('thanks', 'u2'),
    ])
  })
})

describe('toManagedHttpBody', () => {
  it('turns quotes and attachments into text and drops the parts the endpoint would reject', () => {
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
            buildAttachmentPart({ localFileId: 'f1', filename: 'doc.pdf', mimeType: 'application/pdf' }),
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
            { type: 'text', text: '  ' },
          ],
        },
        userMessage('thanks', 'u2'),
      ],
    })

    const forwarded = toManagedHttpBody(body)

    expect(forwarded).toEqual({
      id: 't1',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [
            { type: 'text', text: '> quoted line' },
            { type: 'text', text: 'about this' },
            { type: 'text', text: '[Attachment "doc.pdf" could not be delivered to this agent]' },
          ],
        },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
        userMessage('thanks', 'u2'),
      ],
    })
  })

  it('drops file parts from assistant messages without a note, since the user sent none there', () => {
    const file = { type: 'file' as const, mediaType: 'image/png', url: 'data:image/png;base64,AA==' }
    const body = JSON.stringify({
      id: 't1',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'look' }, file] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'here' }, file] },
        userMessage('thanks', 'u2'),
      ],
    })

    const { messages } = toManagedHttpBody(body)

    expect(messages[1]!.parts).toEqual([{ type: 'text', text: 'here' }])
  })

  it('starts on a user message after filtering empties the leading turn', () => {
    // A blank leading user turn empties, so the assistant reply after it would lead.
    // A later assistant turn held only a file, which assistants may not send.
    const body = JSON.stringify({
      id: 't1',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: ' ' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'got it' }] },
        userMessage('draw it', 'u2'),
        {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }],
        },
        userMessage('thanks', 'u3'),
      ],
    })

    const { messages } = toManagedHttpBody(body)

    expect(messages.map((message) => message.id)).toEqual(['u2', 'u3'])
  })

  it('refuses a history that would not end on a user message', () => {
    const body = JSON.stringify({
      id: 't1',
      messages: [userMessage('hi'), { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }],
    })

    expect(() => toManagedHttpBody(body)).toThrow('start and end with a user message')
  })

  it('keeps the most recent 200 messages and starts the history on a user message', () => {
    // 201 alternating messages, m0 … m200. The last 200 start on an assistant
    // message, so it is dropped too, leaving 199 that start and end on a user turn.
    const messages = Array.from({ length: 201 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `message ${index}` }],
    }))

    const forwarded = toManagedHttpBody(JSON.stringify({ id: 't1', messages }))

    expect(forwarded.messages).toHaveLength(199)
    expect(forwarded.messages[0]).toMatchObject({ id: 'm2', role: 'user' })
    expect(forwarded.messages.at(-1)).toMatchObject({ id: 'm200', role: 'user' })
  })

  it('keeps a full 200 when the cut already lands on a user message', () => {
    const messages = Array.from({ length: 250 }, (_, index) => userMessage(`message ${index}`, `m${index}`))

    const forwarded = toManagedHttpBody(JSON.stringify({ id: 't1', messages }))

    expect(forwarded.messages).toHaveLength(200)
    expect(forwarded.messages[0]!.id).toBe('m50')
    expect(forwarded.messages.at(-1)!.id).toBe('m249')
  })
})
