/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { ImageSupportInconclusiveError, probeImageSupport } from './image-support-probe'

type RecordedRequest = { url: string; init: RequestInit; body: { model: string; messages: [{ content: unknown }] } }

/** A proxy fetch that replies with the queued responses in order and records each request. */
const createFetch = (...responses: Response[]) => {
  const requests: RecordedRequest[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ url: String(input), init, body: JSON.parse(String(init.body)) })
      const response = responses.shift()
      if (!response) {
        throw new Error('Unexpected probe request')
      }
      return response
    },
    { preconnect: async () => true },
  ) as FetchFn
  return { requests, getProxyFetch: () => fetch }
}

const completion = (message: { content?: string | null; reasoning_content?: string }) =>
  Response.json({ choices: [{ message }] })

// A non-loopback custom endpoint goes through the (injected) proxy fetch.
const customModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'custom-1',
    name: 'My VLM',
    provider: 'custom',
    model: 'qwen-vl',
    url: 'https://llm.example.com/v1',
    apiKey: 'sk-test',
    ...overrides,
  }) as Model

describe('probeImageSupport', () => {
  it('reports support when the model names the image color', async () => {
    const { requests, getProxyFetch } = createFetch(completion({ content: 'Green.' }))

    expect(await probeImageSupport(customModel(), getProxyFetch)).toBe('supported')

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request.url).toBe('https://llm.example.com/v1/chat/completions')
    expect(request.init.method).toBe('POST')
    expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer sk-test')
    expect(request.body).toMatchObject({ model: 'qwen-vl', stream: false })
    expect(request.body.messages[0].content).toContainEqual({
      type: 'image_url',
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    })
  })

  it('sends no Authorization header to a keyless endpoint', async () => {
    const { requests, getProxyFetch } = createFetch(completion({ content: 'green' }))
    await probeImageSupport(customModel({ apiKey: null }), getProxyFetch)
    expect(new Headers(requests[0].init.headers).has('Authorization')).toBe(false)
  })

  it('reads the answer from reasoning when the content is empty', async () => {
    const { getProxyFetch } = createFetch(completion({ content: '', reasoning_content: 'The square is green' }))
    expect(await probeImageSupport(customModel(), getProxyFetch)).toBe('supported')
  })

  it('reports no support when the server accepts the image but the model never sees it', async () => {
    const { getProxyFetch } = createFetch(completion({ content: "I can't see images." }))
    expect(await probeImageSupport(customModel(), getProxyFetch)).toBe('unsupported')
  })

  it('reports no support when the provider rejects the image but accepts plain text', async () => {
    const { requests, getProxyFetch } = createFetch(
      Response.json({ message: 'qwen is not a multimodal model' }, { status: 400 }),
      completion({ content: 'ok' }),
    )

    expect(await probeImageSupport(customModel(), getProxyFetch)).toBe('unsupported')
    expect(requests).toHaveLength(2)
    expect(requests[1].body.messages[0].content).toBeTypeOf('string')
    // One deadline covers both requests, capping how long the composer holds the send.
    expect(requests[1].init.signal).toBe(requests[0].init.signal)
  })

  it('stays inconclusive when the provider rejects plain text too', async () => {
    const { getProxyFetch } = createFetch(new Response('', { status: 400 }), new Response('', { status: 400 }))
    await expect(probeImageSupport(customModel(), getProxyFetch)).rejects.toBeInstanceOf(ImageSupportInconclusiveError)
  })

  it('stays inconclusive on auth, rate-limit, and server errors without a follow-up request', async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const { requests, getProxyFetch } = createFetch(new Response('', { status }))
      await expect(probeImageSupport(customModel(), getProxyFetch)).rejects.toBeInstanceOf(
        ImageSupportInconclusiveError,
      )
      expect(requests).toHaveLength(1)
    }
  })

  it('stays inconclusive when the completion carries no answer', async () => {
    const { getProxyFetch } = createFetch(completion({ content: null }))
    await expect(probeImageSupport(customModel(), getProxyFetch)).rejects.toBeInstanceOf(ImageSupportInconclusiveError)
  })

  it('stays inconclusive without a request when the model has no OpenAI-compatible connection', async () => {
    const { requests, getProxyFetch } = createFetch()
    const keylessOpenAi = customModel({ provider: 'openai', url: null, apiKey: null })
    await expect(probeImageSupport(keylessOpenAi, getProxyFetch)).rejects.toBeInstanceOf(ImageSupportInconclusiveError)
    expect(requests).toHaveLength(0)
  })
})
