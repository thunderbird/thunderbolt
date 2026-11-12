/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Tool } from 'ai'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import { createSessionHistoryBudget, sessionHistoryLimits, utf8Bytes } from '@/session-history/limits'
import { canUseSavedMemory, type MemoryProviderTarget } from './access'
import { memoryProviderForServer } from './selection'

export type MemoryMcpAccess = {
  isAllowed: (provider?: MemoryProviderTarget) => Promise<boolean>
  protectTool: (provider: MemoryProviderTarget, tool: Tool) => Tool
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value

/** Apply one thread's live memory policy to every capability of a memory MCP server. */
export const createMemoryMcpAccess = (
  db: AnyDrizzleDatabase,
  currentThreadId: string | undefined,
  providerSelection: string,
): MemoryMcpAccess => {
  const identity = getIdentitySignal()
  const withinBudget = createSessionHistoryBudget()
  const modelBudget = { remaining: sessionHistoryLimits.turnBytes as number }
  const accountForModelOutput = (encoded: string) => {
    const bytes = utf8Bytes(encoded)
    if (bytes > sessionHistoryLimits.readBytes || bytes > modelBudget.remaining) {
      throw new Error('Memory provider output exceeds the context budget. Request fewer or more targeted results.')
    }
    modelBudget.remaining -= bytes
  }
  const isAllowed = async (provider?: MemoryProviderTarget) =>
    // A live selection change can narrow this request, never mix two providers in one context.
    providerSelection === (provider ? memoryProviderForServer(provider.id) : 'builtin') &&
    !identity.aborted &&
    (await canUseSavedMemory(db, currentThreadId, provider))
  const assertAllowed = async (provider: MemoryProviderTarget, signal?: AbortSignal) => {
    identity.throwIfAborted()
    signal?.throwIfAborted()
    if (!(await isAllowed(provider))) {
      throw new Error(
        'Saved memory is unavailable in private chats, when memory is disabled, or for an unselected provider.',
      )
    }
    identity.throwIfAborted()
    signal?.throwIfAborted()
  }
  const resolveOutput = async (
    provider: MemoryProviderTarget,
    output: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (!isAsyncIterable(output)) {
      return output
    }
    const iterator = output[Symbol.asyncIterator]()
    const state: { final: unknown } = { final: undefined }
    try {
      while (true) {
        await assertAllowed(provider, signal)
        const next = await iterator.next()
        await assertAllowed(provider, signal)
        if (next.done) {
          return state.final
        }
        state.final = next.value
      }
    } finally {
      await iterator.return?.()
    }
  }
  return {
    isAllowed,
    protectTool: (provider, tool) => ({
      ...tool,
      description: `${tool.description ?? ''}\nSaved memory is available only in public chats with memory enabled. Request targeted results: outputs are bounded to 12 KiB each and 32 KiB per turn.`,
      execute: async (input, options) => {
        const signal = AbortSignal.any([identity, ...(options.abortSignal ? [options.abortSignal] : [])])
        await assertAllowed(provider, signal)
        const execution = { started: false }
        const encoded = await withinBudget(sessionHistoryLimits.readBytes, async (maxBytes) => {
          execution.started = true
          await assertAllowed(provider, signal)
          if (!tool.execute) {
            throw new Error('This memory tool cannot be executed.')
          }
          const output = await resolveOutput(
            provider,
            await tool.execute(input, { ...options, abortSignal: signal }),
            signal,
          )
          await assertAllowed(provider, signal)
          const result = JSON.stringify(output) ?? 'null'
          if (utf8Bytes(result) > maxBytes) {
            throw new Error(
              'Memory provider output exceeds the context budget. Request fewer or more targeted results.',
            )
          }
          return result
        })
        if (!execution.started) {
          throw new Error('Saved memory budget exhausted for this turn. Use the information already retrieved.')
        }
        if (!tool.toModelOutput) {
          accountForModelOutput(encoded)
        }
        return JSON.parse(encoded) as unknown
      },
      ...(tool.toModelOutput
        ? {
            toModelOutput: async (options) => {
              await assertAllowed(provider)
              const output = await tool.toModelOutput!(options)
              await assertAllowed(provider)
              accountForModelOutput(JSON.stringify(output))
              return output
            },
          }
        : {}),
    }),
  }
}
