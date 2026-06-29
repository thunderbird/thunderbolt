/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Drives the built-in ACP agent through a real in-memory ACP connection pair —
 * a {@link ClientSideConnection} talking to an {@link AgentSideConnection} over
 * two linked byte streams — backed by a fake harness so the full
 * initialize → newSession → prompt round-trip runs with no API key. Asserts the
 * harness run events stream out as ACP `session/update`s, the tool-permission
 * request round-trips to the client, and `session/cancel` yields `cancelled`.
 */

import { describe, expect, test } from 'bun:test'
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Client,
  RequestPermissionRequest,
  SessionNotification,
  Stream,
} from '@agentclientprotocol/sdk'
import type { StopReason as PiStopReason, AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentHarnessEvent, ToolCallEvent, ToolCallResult } from '@earendil-works/pi-agent-core'
import { createHarnessAgent } from './harness-agent.ts'
import type { BuildServeHarness } from './harness-agent.ts'
import type { ServeConfig } from '../agent/types.ts'

const config: ServeConfig = { model: 'fake', cwd: process.cwd(), yolo: false, thinking: 'medium' }

/** A minimal-but-valid Pi assistant message; the translator only reads the
 *  streamed deltas and the final `stopReason`, but the event types require a
 *  fully-shaped message, so this fills in the rest with zeros. */
const assistantMessage = (stopReason: PiStopReason): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'fake',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
})

/** Wire a client and the built-in agent together over an in-memory ndjson pipe
 *  pair, returning the client connection plus the buffers the client records. */
const connectPair = (
  buildServeHarness: BuildServeHarness,
): {
  client: ClientSideConnection
  updates: SessionNotification[]
  permissions: RequestPermissionRequest[]
} => {
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)

  new AgentSideConnection((conn) => createHarnessAgent(conn, config, buildServeHarness), agentStream)

  const updates: SessionNotification[] = []
  const permissions: RequestPermissionRequest[] = []
  const handler: Client = {
    sessionUpdate: async (params) => {
      updates.push(params)
    },
    requestPermission: async (params) => {
      permissions.push(params)
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    },
  }
  const client = new ClientSideConnection(() => handler, clientStream)
  return { client, updates, permissions }
}

/** A fake harness whose prompt streams a text delta, asks to run `bash` (driving
 *  the permission round-trip), then reports the tool completing. */
const streamingBuilder: BuildServeHarness = async () => {
  let emit: (event: AgentHarnessEvent) => void = () => {}
  let gate: ((event: ToolCallEvent) => Promise<ToolCallResult | undefined>) | null = null
  return {
    harness: {
      subscribe: (listener) => {
        emit = listener
        return () => {
          emit = () => {}
        }
      },
      registerToolCallGate: (h) => {
        gate = h
      },
      prompt: async (text) => {
        emit({
          type: 'message_update',
          message: assistantMessage('stop'),
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `you said: ${text}`, partial: assistantMessage('stop') },
        })
        const decision = await gate?.({ type: 'tool_call', toolCallId: 't1', toolName: 'bash', input: { command: 'echo hi' } })
        if (!decision?.block) {
          emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'echo hi' } })
          emit({
            type: 'tool_execution_end',
            toolCallId: 't1',
            toolName: 'bash',
            result: { content: [{ type: 'text', text: 'hi' }], details: {} },
            isError: false,
          })
        }
        return assistantMessage('stop')
      },
      waitForIdle: async () => {},
      abort: async () => {},
    },
    dispose: async () => {},
  }
}

describe('createHarnessAgent (ACP server)', () => {
  test('initialize advertises no loadSession and negotiates the protocol version', async () => {
    const { client } = connectPair(streamingBuilder)
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(init.agentCapabilities?.loadSession).toBe(false)
    expect(init.agentInfo?.name).toBe('thunderbolt')
  })

  test('a prompt streams text + tool-call updates and round-trips a permission request', async () => {
    const { client, updates, permissions } = connectPair(streamingBuilder)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const response = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello agent' }] })
    expect(response.stopReason).toBe('end_turn')

    // The gated `bash` tool asked the client for permission exactly once.
    expect(permissions).toHaveLength(1)
    expect(permissions[0].toolCall.toolCallId).toBe('t1')
    expect(permissions[0].toolCall.kind).toBe('execute')

    const kinds = updates.map((u) => u.update.sessionUpdate)
    expect(kinds).toContain('agent_message_chunk')
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('tool_call_update')

    const textChunk = updates.find((u) => u.update.sessionUpdate === 'agent_message_chunk')
    expect(textChunk?.update).toMatchObject({ content: { type: 'text', text: 'you said: hello agent' } })

    const toolCall = updates.find((u) => u.update.sessionUpdate === 'tool_call')
    expect(toolCall?.update).toMatchObject({ toolCallId: 't1', kind: 'execute', status: 'in_progress' })

    const toolDone = updates.find((u) => u.update.sessionUpdate === 'tool_call_update')
    expect(toolDone?.update).toMatchObject({ toolCallId: 't1', status: 'completed' })
  })

  test('a denied permission blocks the tool and the model never sees it run', async () => {
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    new AgentSideConnection(
      (conn) => createHarnessAgent(conn, config, streamingBuilder),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    )
    const updates: SessionNotification[] = []
    const denyingClient: Client = {
      sessionUpdate: async (params) => {
        updates.push(params)
      },
      requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } }),
    }
    const client = new ClientSideConnection(() => denyingClient, ndJsonStream(clientToAgent.writable, agentToClient.readable))

    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    // Rejected: no tool_call / tool_call_update was streamed for the blocked bash.
    const kinds = updates.map((u) => u.update.sessionUpdate)
    expect(kinds).not.toContain('tool_call')
    expect(kinds).not.toContain('tool_call_update')
  })

  test('session/cancel aborts the in-flight turn and resolves as cancelled', async () => {
    let release: (() => void) | null = null
    let abortedEarly = false
    const cancellingBuilder: BuildServeHarness = async () => ({
      harness: {
        subscribe: () => () => {},
        registerToolCallGate: () => {},
        prompt: async () => {
          if (!abortedEarly) await new Promise<void>((resolve) => (release = resolve))
          return assistantMessage('aborted')
        },
        waitForIdle: async () => {},
        abort: async () => {
          abortedEarly = true
          release?.()
        },
      },
      dispose: async () => {},
    })

    const { client } = connectPair(cancellingBuilder)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const pending = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'long task' }] })
    await client.cancel({ sessionId })
    const response = await pending
    expect(response.stopReason).toBe('cancelled')
  })
})
