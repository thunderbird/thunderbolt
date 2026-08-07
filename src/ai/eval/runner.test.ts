/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import { http } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { AgentAdapter } from '@/types/acp'
import type { Model, ThunderboltUIMessage } from '@/types'
import { defaultModelOpus5 } from '@shared/defaults/models'
import { createEvalAdapterContext, fetchAndParseTurn } from './runner'

const model: Model = { ...defaultModelOpus5, apiKey: null }
const proxyFetch: FetchFn = Object.assign(async () => new Response(), {
  preconnect: async () => false,
})
const userMessage = (text: string): ThunderboltUIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
})

const adapterWithFetch = (fetch: AgentAdapter['fetch']): AgentAdapter => ({
  agent: builtInAgent,
  capabilities: null,
  fetch,
  ensureSession: async () => {},
  disconnect: () => {},
})

const contextFor = (messages: ThunderboltUIMessage[]) =>
  createEvalAdapterContext({
    threadId: crypto.randomUUID(),
    selectedModel: model,
    messages,
    httpClient: http,
    getProxyFetch: () => proxyFetch,
  })

/** Create a deterministic timeout scheduler controlled directly by each test. */
const manualTimeout = () => {
  const callbacks: Array<() => void> = []
  return {
    schedule: (callback: () => void) => {
      callbacks.push(callback)
      return () => {}
    },
    fire: () => callbacks[0]?.(),
  }
}

describe('createEvalAdapterContext', () => {
  test('builds each turn budget from the last user message', () => {
    const search = contextFor([userMessage('/research old turn'), userMessage('/search latest turn')])
    const research = contextFor([userMessage('/research latest turn')])
    const chat = contextFor([userMessage('no explicit web skill')])

    expect(search.webToolBudget?.intent).toBe('search')
    expect(research.webToolBudget?.intent).toBe('research')
    expect(chat.webToolBudget?.intent).toBe('auto')
  })
})

describe('fetchAndParseTurn', () => {
  test('aborts an adapter request that does not settle before the timeout', async () => {
    const observed: { signal?: AbortSignal } = {}
    const adapter = adapterWithFetch(
      (init) =>
        new Promise<Response>(() => {
          observed.signal = init.signal ?? undefined
        }),
    )
    const timeout = manualTimeout()

    const turn = fetchAndParseTurn(
      adapter,
      { method: 'POST', body: '{}' },
      contextFor([userMessage('hello')]),
      5,
      timeout.schedule,
    )
    timeout.fire()

    await expect(turn).rejects.toThrow('Scenario timed out')
    expect(observed.signal?.aborted).toBe(true)
  })

  test('cancels stream parsing when the timeout fires', async () => {
    const state = { canceled: false }
    const adapter = adapterWithFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          state.canceled = true
        },
      })
      return new Response(body)
    })
    const timeout = manualTimeout()

    const turn = fetchAndParseTurn(
      adapter,
      { method: 'POST', body: '{}' },
      contextFor([userMessage('hello')]),
      5,
      timeout.schedule,
    )
    timeout.fire()

    await expect(turn).rejects.toThrow('Scenario timed out')
    expect(state.canceled).toBe(true)
  })
})
