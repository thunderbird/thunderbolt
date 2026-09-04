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
        emit({
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'search_web',
          args: {},
        } as AgentHarnessEvent)
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

/** Harness fake that records aborts and lets the test drive events by hand. */
const createHarnessFake = () => {
  const listeners = new Set<(event: AgentHarnessEvent) => void>()
  const state = { abortCount: 0 }
  const harness = {
    subscribe: (listener: (event: AgentHarnessEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    abort: async () => {
      state.abortCount += 1
      return { clearedSteer: [], clearedFollowUp: [] }
    },
  } as unknown as AgentHarness
  return {
    harness,
    state,
    listenerCount: () => listeners.size,
    emit: (event: AgentHarnessEvent): void => listeners.forEach((listener) => listener(event)),
  }
}

describe('piHarnessToUiMessageStream abort', () => {
  it('closes the stream and aborts the harness when the signal fires mid-run', async () => {
    const { harness, state, emit, listenerCount } = createHarnessFake()
    const controller = new AbortController()
    // The harness never settles on its own — only the abort can end this stream,
    // which is the regression: Stop used to leave the loop running forever.
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        emit({ type: 'agent_start' } as AgentHarnessEvent)
        emit({ type: 'turn_start' } as AgentHarnessEvent)
        return new Promise<void>(() => {})
      },
      {},
      controller.signal,
    )

    const consumed = new Response(stream).text()
    controller.abort()
    const output = await consumed

    expect(state.abortCount).toBe(1)
    expect(listenerCount()).toBe(0)
    // The turn settles as a well-formed message rather than a dangling step.
    expect(output).toContain('"type":"finish-step"')
    expect(output).toContain('"type":"finish"')
    expect(output).toContain('[DONE]')
  })

  it('closes the open reasoning part so its spinner stops', async () => {
    const { harness, emit } = createHarnessFake()
    const controller = new AbortController()
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        emit({ type: 'agent_start' } as AgentHarnessEvent)
        emit({ type: 'turn_start' } as AgentHarnessEvent)
        emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
        } as AgentHarnessEvent)
        return new Promise<void>(() => {})
      },
      {},
      controller.signal,
    )

    const consumed = new Response(stream).text()
    controller.abort()

    expect(await consumed).toContain('"type":"reasoning-end"')
  })

  it('emits nothing when the signal aborts before the first chunk', async () => {
    const { harness, state } = createHarnessFake()
    const controller = new AbortController()
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        // Reached only if the abort failed to short-circuit the run.
        state.abortCount = -1
        return new Promise<void>(() => {})
      },
      {},
      controller.signal,
    )

    const consumed = new Response(stream).text()
    controller.abort()
    const output = await consumed

    // A synthetic start/finish here would read as an empty assistant turn, and
    // the chat auto-retries those — restarting the turn the user cancelled.
    expect(output).not.toContain('"type":"start"')
    expect(output).not.toContain('"type":"finish"')
    expect(output).toContain('[DONE]')
  })

  it('never starts the run when the signal is already aborted', async () => {
    const { harness, state } = createHarnessFake()
    const stream = piHarnessToUiMessageStream(
      harness,
      () => {
        state.abortCount = -1
        return new Promise<void>(() => {})
      },
      {},
      AbortSignal.abort(),
    )

    const output = await new Response(stream).text()

    expect(state.abortCount).toBe(0)
    expect(output).toBe('data: [DONE]\n\n')
  })
})
