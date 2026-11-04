/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { CloudError } from './errors'

const invocation = new AsyncLocalStorage<{ dispatched: boolean }>()

/** Wrap the final network hop, after URL and credential checks, to identify actual tools/call dispatch. */
export const createMcpDispatchFetch = (upstream: typeof fetch): typeof fetch => {
  const send = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const active = invocation.getStore()
    if (active) {
      const request = new Request(input, init)
      request.signal.throwIfAborted()
      if (request.method === 'POST') {
        const message: unknown = await request.clone().json()
        if (typeof message === 'object' && message !== null && 'method' in message && message.method === 'tools/call') {
          active.dispatched = true
        }
      }
    }
    return upstream(input, init)
  }
  return Object.assign(send, { preconnect: upstream.preconnect })
}

/** A thrown error after dispatch cannot establish whether the remote side effect happened. */
export const executeMcpToolCall = <T>(execute: () => Promise<T>): Promise<T> => {
  const state = { dispatched: false }
  return invocation.run(state, async () => {
    try {
      return await execute()
    } catch (error) {
      if (state.dispatched) {
        throw new CloudError(409, 'tool_outcome_uncertain')
      }
      throw error
    }
  })
}
