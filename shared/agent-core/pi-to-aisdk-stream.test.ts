/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AgentHarness, AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import { piHarnessToUiMessageStream } from './pi-to-aisdk-stream.ts'

describe('piHarnessToUiMessageStream metadata', () => {
  it('emits initial, invoked-tool, and settled metadata', async () => {
    const listeners = new Set<(event: AgentHarnessEvent) => void>()
    const harness = {
      subscribe: (listener: (event: AgentHarnessEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      abort: async () => ({ aborted: true }),
    } as unknown as AgentHarness
    const emit = (event: AgentHarnessEvent): void => listeners.forEach((listener) => listener(event))
    const stream = piHarnessToUiMessageStream(
      harness,
      async () => {
        emit({ type: 'agent_start' } as AgentHarnessEvent)
        emit({ type: 'turn_start' } as AgentHarnessEvent)
        emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'search_web', args: {} } as AgentHarnessEvent)
        emit({
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          toolName: 'search_web',
          result: { content: [{ type: 'text', text: 'done' }] },
          isError: false,
        } as AgentHarnessEvent)
        emit({ type: 'turn_end', message: { stopReason: 'stop' }, toolResults: [] } as unknown as AgentHarnessEvent)
        emit({ type: 'agent_end', messages: [] } as AgentHarnessEvent)
      },
      {
        initial: { modelId: 'model-1' },
        toolCall: (toolName) => ({ mcpTools: { [toolName]: { name: 'Search' } } }),
        settled: () => ({ sources: [{ id: 'source-1' }] }),
      },
    )

    const output = await new Response(stream).text()

    expect(output).toContain('"messageMetadata":{"modelId":"model-1"}')
    expect(output).toContain('"mcpTools":{"search_web":{"name":"Search"}}')
    expect(output).toContain('"sources":[{"id":"source-1"}]')
  })
})
