/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Tool } from 'ai'

export type AgentToolCall = { toolName: string; toolCallId: string; input: unknown }
export type RequestAgentToolApproval = (call: AgentToolCall, signal?: AbortSignal) => Promise<boolean>

/** Gate legacy tool execution while preserving streamed and ordinary tool outputs. */
export const withAgentToolApprovals = (
  tools: Record<string, Tool>,
  approve?: RequestAgentToolApproval,
): Record<string, Tool> => {
  if (!approve) {
    return tools
  }
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, tool]) => {
      const execute = tool.execute
      if (!execute || toolName === 'skill') {
        return [toolName, tool]
      }
      const gated: Tool = {
        ...tool,
        execute: (input, options) => ({
          async *[Symbol.asyncIterator]() {
            const allowed = await approve({ toolName, input, toolCallId: options.toolCallId }, options.abortSignal)
            if (!allowed || options.abortSignal?.aborted) {
              throw new Error('This tool call was not approved.')
            }
            const output = await execute(input, options)
            if (output !== null && typeof output === 'object' && Symbol.asyncIterator in output) {
              yield* output as AsyncIterable<unknown>
            } else {
              yield output
            }
          },
        }),
      }
      return [toolName, gated]
    }),
  )
}
