/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
import { withAgentToolApprovals } from './agent-tool-approval'

/** Drain the same async iterable shape supported by AI SDK tool execution. */
const drain = async (output: unknown): Promise<unknown[]> => {
  const resolved = await output
  if (resolved && typeof resolved === 'object' && Symbol.asyncIterator in resolved) {
    const values: unknown[] = []
    for await (const value of resolved as AsyncIterable<unknown>) {
      values.push(value)
    }
    return values
  }
  return [resolved]
}

describe('legacy agent tool approval boundary', () => {
  it('does not execute a denied tool', async () => {
    const execute = mock(async () => 'executed')
    const tools = withAgentToolApprovals({ write: tool({ inputSchema: z.object({}), execute }) }, async () => false)
    await expect(drain(tools.write.execute!({}, { toolCallId: 'call', messages: [] }))).rejects.toThrow('not approved')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after the approval settles', async () => {
    const abort = new AbortController()
    const execute = mock(async () => 'executed')
    const tools = withAgentToolApprovals({ write: tool({ inputSchema: z.object({}), execute }) }, async () => {
      abort.abort()
      return true
    })
    await expect(
      drain(tools.write.execute!({}, { toolCallId: 'call', messages: [], abortSignal: abort.signal })),
    ).rejects.toThrow('not approved')
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps incremental outputs after an approval and leaves ordinary built-in tools alone', async () => {
    const output = {
      async *[Symbol.asyncIterator]() {
        yield 'first'
        yield 'second'
      },
    }
    const original = { stream: tool({ inputSchema: z.object({}), execute: () => output }) }
    expect(withAgentToolApprovals(original)).toBe(original)
    const tools = withAgentToolApprovals(original, async () => true)
    expect(await drain(tools.stream.execute!({}, { toolCallId: 'call', messages: [] }))).toEqual(['first', 'second'])
  })
})
