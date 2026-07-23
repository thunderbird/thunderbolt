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
import { realpath } from 'node:fs/promises'
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
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import type { AgentHarnessEvent, Session as PiSession, ToolCallEvent, ToolCallResult } from '@earendil-works/pi-agent-core'
import { createHarnessAgent } from './harness-agent.ts'
import type { BuildServeHarness } from './harness-agent.ts'
import type { SessionStore } from './session-store.ts'
import type { ServeConfig } from '../agent/types.ts'

const config: ServeConfig = { model: 'fake', cwd: process.cwd(), yolo: false, thinking: 'medium' }

/** A fake {@link SessionStore} backed by Pi's real in-memory repo (no disk, no
 *  mocks): each id maps to one session, and it records the new/resume calls so a
 *  test can assert the agent routed to the right one. */
const fakeStore = (): SessionStore & {
  created: Array<{ id: string; cwd: string }>
  resumed: Array<{ id: string; cwd: string }>
} => {
  const repo = new InMemorySessionRepo()
  const byId = new Map<string, Promise<PiSession>>()
  const created: Array<{ id: string; cwd: string }> = []
  const resumed: Array<{ id: string; cwd: string }> = []
  const get = (id: string): Promise<PiSession> => {
    const existing = byId.get(id)
    if (existing) return existing
    const fresh = repo.create({ id })
    byId.set(id, fresh)
    return fresh
  }
  return {
    created,
    resumed,
    createSession: (id, cwd) => {
      created.push({ id, cwd })
      return get(id)
    },
    openSession: (id, cwd) => {
      resumed.push({ id, cwd })
      return get(id)
    },
  }
}

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
  store: SessionStore = fakeStore(),
  permissionOptionId: 'allow-once' | 'allow-always' | 'reject-once' = 'allow-once',
): {
  client: ClientSideConnection
  updates: SessionNotification[]
  permissions: RequestPermissionRequest[]
} => {
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)

  new AgentSideConnection((conn) => createHarnessAgent(conn, config, store, buildServeHarness), agentStream)

  const updates: SessionNotification[] = []
  const permissions: RequestPermissionRequest[] = []
  const handler: Client = {
    sessionUpdate: async (params) => {
      updates.push(params)
    },
    requestPermission: async (params) => {
      permissions.push(params)
      return { outcome: { outcome: 'selected', optionId: permissionOptionId } }
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
  test('initialize advertises resume (not loadSession) and negotiates the protocol version', async () => {
    const { client } = connectPair(streamingBuilder)
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(init.agentCapabilities?.loadSession).toBe(false)
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined()
    expect(init.agentInfo?.name).toBe('thunderbolt')
  })

  test('session/resume opens the stored session by id and injects it into the harness (no replay)', async () => {
    const store = fakeStore()
    const injected: PiSession[] = []
    const capturingBuilder: BuildServeHarness = async (_config, session) => {
      injected.push(session)
      return {
        harness: {
          subscribe: () => () => {},
          registerToolCallGate: () => {},
          prompt: async () => assistantMessage('stop'),
          waitForIdle: async () => {},
          abort: async () => {},
        },
        dispose: async () => {},
      }
    }

    const threadId = '11111111-1111-4111-8111-111111111111'
    const { client, updates } = connectPair(capturingBuilder, store)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await client.resumeSession({ sessionId: threadId, cwd: '/', mcpServers: [] })

    // Resume returns an empty response and replays nothing to the client.
    expect(response).toEqual({})
    expect(updates).toHaveLength(0)
    // It routed through the store by client-supplied id + server-owned cwd...
    expect(store.resumed).toEqual([{ id: threadId, cwd: await realpath(config.cwd) }])
    // ...and handed that exact session to the harness builder.
    expect(injected).toHaveLength(1)
    expect((await injected[0].getMetadata()).id).toBe(threadId)

    // A resumed session is live: a prompt against it succeeds.
    const prompt = await client.prompt({ sessionId: threadId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(prompt.stopReason).toBe('end_turn')
  })

  test('session/resume rejects a path-traversal id before it reaches the store', async () => {
    const store = fakeStore()
    const { client } = connectPair(streamingBuilder, store)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(
      client.resumeSession({ sessionId: '../../../../../tmp/x', cwd: process.cwd(), mcpServers: [] }),
    ).rejects.toThrow(/invalid session id/)

    // The guard short-circuits before the store's path builder ever runs, so no
    // `.jsonl` can be written outside the sessions root.
    expect(store.resumed).toHaveLength(0)
  })

  test('re-resuming a live session id disposes the prior harness (no leak)', async () => {
    const disposed: number[] = []
    let n = 0
    const trackingBuilder: BuildServeHarness = async () => {
      const id = n++
      return {
        harness: {
          subscribe: () => () => {},
          registerToolCallGate: () => {},
          prompt: async () => assistantMessage('stop'),
          waitForIdle: async () => {},
          abort: async () => {},
        },
        dispose: async () => {
          disposed.push(id)
        },
      }
    }

    const threadId = '22222222-2222-4222-8222-222222222222'
    const { client } = connectPair(trackingBuilder)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await client.resumeSession({ sessionId: threadId, cwd: process.cwd(), mcpServers: [] })
    await client.resumeSession({ sessionId: threadId, cwd: process.cwd(), mcpServers: [] })

    // The first harness (id 0) was torn down when the second replaced it.
    expect(disposed).toEqual([0])
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

  test('session/new ignores client cwd and binds store plus harness to trusted launch directory', async () => {
    const store = fakeStore()
    const harnessCwds: string[] = []
    const capturingBuilder: BuildServeHarness = async (harnessConfig, session) => {
      harnessCwds.push(harnessConfig.cwd)
      return streamingBuilder(harnessConfig, session)
    }
    const { client } = connectPair(capturingBuilder, store)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await client.newSession({ cwd: '/', mcpServers: [] })

    const trustedRoot = await realpath(config.cwd)
    expect(store.created).toHaveLength(1)
    expect(store.created[0]?.cwd).toBe(trustedRoot)
    expect(harnessCwds).toEqual([trustedRoot])
  })

  test('read is auto-allowed only when real path stays inside trusted workspace', async () => {
    const decisions: Array<ToolCallResult | undefined> = []
    const readBuilder: BuildServeHarness = async () => {
      let gate: ((event: ToolCallEvent) => Promise<ToolCallResult | undefined>) | null = null
      return {
        harness: {
          subscribe: () => () => {},
          registerToolCallGate: (handler) => {
            gate = handler
          },
          prompt: async () => {
            decisions.push(
              await gate?.({ type: 'tool_call', toolCallId: 'inside', toolName: 'read', input: { path: 'package.json' } }),
            )
            decisions.push(
              await gate?.({ type: 'tool_call', toolCallId: 'outside-1', toolName: 'read', input: { path: '/etc/passwd' } }),
            )
            decisions.push(
              await gate?.({ type: 'tool_call', toolCallId: 'outside-2', toolName: 'read', input: { path: '/etc/passwd' } }),
            )
            return assistantMessage('stop')
          },
          waitForIdle: async () => {},
          abort: async () => {},
        },
        dispose: async () => {},
      }
    }

    const { client, permissions } = connectPair(readBuilder, fakeStore(), 'allow-always')
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: '/', mcpServers: [] })
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'read' }] })

    expect(permissions.map((request) => request.toolCall.toolCallId)).toEqual(['outside-1', 'outside-2'])
    expect(decisions).toEqual([undefined, undefined, undefined])
  })

  test('webfetch is auto-allowed without prompting while bash stays gated', async () => {
    const decisions: Array<ToolCallResult | undefined> = []
    const webBuilder: BuildServeHarness = async () => {
      let gate: ((event: ToolCallEvent) => Promise<ToolCallResult | undefined>) | null = null
      return {
        harness: {
          subscribe: () => () => {},
          registerToolCallGate: (handler) => {
            gate = handler
          },
          prompt: async () => {
            decisions.push(
              await gate?.({
                type: 'tool_call',
                toolCallId: 'web',
                toolName: 'webfetch',
                input: { url: 'https://example.com' },
              }),
            )
            decisions.push(
              await gate?.({ type: 'tool_call', toolCallId: 'shell', toolName: 'bash', input: { command: 'curl x' } }),
            )
            return assistantMessage('stop')
          },
          waitForIdle: async () => {},
          abort: async () => {},
        },
        dispose: async () => {},
      }
    }

    const { client, permissions } = connectPair(webBuilder, fakeStore(), 'reject-once')
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: '/', mcpServers: [] })
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'web' }] })

    expect(decisions).toEqual([undefined, { block: true, reason: 'user rejected bash' }])
    expect(permissions.map((request) => request.toolCall.toolCallId)).toEqual(['shell'])
  })

  test('a denied permission blocks the tool and the model never sees it run', async () => {
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    new AgentSideConnection(
      (conn) => createHarnessAgent(conn, config, fakeStore(), streamingBuilder),
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
