/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { targetUrlHeader } from '../../../shared/proxy-protocol'
import { buildFreeModelRequest, tryFreeModel, freeModelId } from './free-model'

describe('buildFreeModelRequest', () => {
  it('targets the public /v1/proxy/free endpoint with the OpenRouter target header and no auth', () => {
    const { url, init } = buildFreeModelRequest('https://public.thunderbolt.io/', { prompt: 'Hi' })
    expect(url).toBe('https://public.thunderbolt.io/v1/proxy/free')
    const headers = init.headers as Record<string, string>
    expect(headers[targetUrlHeader]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers.Authorization).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(freeModelId)
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }])
  })
})

describe('tryFreeModel', () => {
  it('fails clearly when no public server is configured', async () => {
    const result = await tryFreeModel(fetch, '')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/public server/i)
    }
  })

  it('succeeds when the endpoint returns ok', async () => {
    const fn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    expect(await tryFreeModel(fn, 'https://public.thunderbolt.io')).toEqual({ ok: true })
  })

  it('surfaces a friendly message on rate limit', async () => {
    const fn = (async () => new Response('', { status: 429 })) as unknown as typeof fetch
    const result = await tryFreeModel(fn, 'https://public.thunderbolt.io')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/daily limit/i)
    }
  })
})
