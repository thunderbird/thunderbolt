/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { saveProviderConnectionInTransaction } from '@/dal/provider-connections'
import { getModel } from '@/dal/models'
import { addProviderModels } from '@/providers/models'
import * as native from '@/lib/native-fetch'
import { createDefaultProbe } from '@/hooks/use-model-connection-test'
import { probeImageSupport } from './image-support-probe'

beforeEach(resetTestDatabase)
afterEach(() => mock.restore())
afterAll(teardownTestDatabase)

/** Exercise the real SDK and bound transport, stubbing only upstream HTTP. */
const setup = async () => {
  const connectionId = await getDb().transaction((tx) =>
    saveProviderConnectionInTransaction(tx, {
      provider: 'openai',
      name: 'ChatGPT',
      authMethod: 'oauth',
      credentials: { access_token: 'plan-token' },
    }),
  )
  const [id] = await addProviderModels(getDb(), connectionId, [{ id: 'gpt-test' }])
  const proxy = Object.assign(
    mock(async () => {
      throw new Error('Plan tokens must not use the proxy')
    }),
    {
      preconnect: async () => false,
    },
  )
  return { model: (await getModel(getDb(), id))!, getProxyFetch: () => proxy, proxy }
}

/** A Responses stream including the terminal event, or a truncated prefix. */
const responseStream = (complete = true) =>
  new Response(
    [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm' } },
      { type: 'response.output_text.delta', item_id: 'm', delta: 'green' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm' } },
      ...(complete ? [{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }] : []),
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )

it.each(['tools', 'images'] as const)(
  'probes ChatGPT %s through streaming Responses without storage or proxying',
  async (probe) => {
    const { model, getProxyFetch, proxy } = await setup()
    const send = spyOn(native, 'nativeFetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/responses')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer plan-token')
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ model: 'gpt-test', stream: true, store: false })
      if (probe === 'tools') {
        expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'get_current_time' })]))
      } else {
        expect(body.input[0].content).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'input_image' })]),
        )
      }
      return responseStream()
    })
    const result =
      probe === 'tools'
        ? await createDefaultProbe()(
            { ...model, url: model.url ?? null, apiKey: model.apiKey ?? null },
            getProxyFetch,
            new AbortController().signal,
          )
        : await probeImageSupport(model, getProxyFetch, new AbortController().signal)
    expect(result).toBe('supported')
    expect(send).toHaveBeenCalledTimes(1)
    expect(proxy).not.toHaveBeenCalled()
  },
)

it.each(['tools', 'images'] as const)(
  'propagates %s stream errors instead of treating HTTP 200 as success',
  async (probe) => {
    const { model, getProxyFetch } = await setup()
    spyOn(native, 'nativeFetch').mockResolvedValue(
      new Response(
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: { error: { message: 'Quota exceeded' } },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const result =
      probe === 'tools'
        ? createDefaultProbe()(
            { ...model, url: model.url ?? null, apiKey: model.apiKey ?? null },
            getProxyFetch,
            new AbortController().signal,
          )
        : probeImageSupport(model, getProxyFetch, new AbortController().signal)
    await expect(result).rejects.toThrow('Model probe did not complete')
  },
)

it.each(['tools', 'images'] as const)(
  'propagates authentication failures from streaming %s probes without retrying',
  async (probe) => {
    const { model, getProxyFetch } = await setup()
    const send = spyOn(native, 'nativeFetch').mockResolvedValue(
      Response.json({ error: { message: 'Expired token' } }, { status: 401 }),
    )
    const result =
      probe === 'tools'
        ? createDefaultProbe()(
            { ...model, url: model.url ?? null, apiKey: model.apiKey ?? null },
            getProxyFetch,
            new AbortController().signal,
          )
        : probeImageSupport(model, getProxyFetch, new AbortController().signal)
    await expect(result).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  },
)

it.each(['tools', 'images'] as const)('does not accept truncated %s probe streams', async (probe) => {
  const { model, getProxyFetch } = await setup()
  spyOn(native, 'nativeFetch').mockResolvedValue(responseStream(false))
  const result =
    probe === 'tools'
      ? createDefaultProbe()(
          { ...model, url: model.url ?? null, apiKey: model.apiKey ?? null },
          getProxyFetch,
          new AbortController().signal,
        )
      : probeImageSupport(model, getProxyFetch, new AbortController().signal)
  await expect(result).rejects.toThrow('Model probe did not complete')
})

it.each(['tools', 'images'] as const)(
  'confirms rejected ChatGPT %s with a streaming control request',
  async (probe) => {
    const { model, getProxyFetch } = await setup()
    const send = spyOn(native, 'nativeFetch')
      .mockResolvedValueOnce(Response.json({ error: { message: 'Unsupported content' } }, { status: 400 }))
      .mockResolvedValueOnce(responseStream())
    const result =
      probe === 'tools'
        ? await createDefaultProbe()(
            { ...model, url: model.url ?? null, apiKey: model.apiKey ?? null },
            getProxyFetch,
            new AbortController().signal,
          )
        : await probeImageSupport(model, getProxyFetch, new AbortController().signal)
    expect(result).toBe('unsupported')
    expect(send).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toMatchObject({ stream: true, store: false })
  },
)
