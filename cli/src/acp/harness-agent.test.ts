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

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
import { AgentSideConnection, ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import type { Client, RequestPermissionRequest, SessionNotification, Stream } from '@agentclientprotocol/sdk'
import type { AgentHarnessEvent, Session as PiSession, ToolCallEvent, ToolCallResult } from '@earendil-works/pi-agent-core'
import { buildWireSkillsMeta, skillsCapabilityMeta, type SkillDefinition } from '../../../shared/agent-core/skills.ts'
import { createHarnessAgent } from './harness-agent.ts'
import type { BuildServeHarness } from './harness-agent.ts'
import type { SessionStore } from './session-store.ts'
import type { CommandSyntaxServeConfig } from '../agent/types.ts'
import type { PreparedPiBinding, ProviderRuntime } from '../provider-runtime/types.ts'
import { assistantMessage, controlledAgent, fakeHarness, fakeStore, preparedBinding, providerRuntime } from './test-fixtures.ts'

const captureRejection = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('Expected operation to reject.')
}

const selection = { providerId: 'selected-profile', model: 'selected-model' }
const config: CommandSyntaxServeConfig = {
  cwd: process.cwd(),
  yolo: false,
  thinking: 'medium',
  selection,
}

/** Wire a client and the built-in agent together over an in-memory ndjson pipe
 *  pair, returning the client connection plus the buffers the client records. */
const connectPair = (
  buildServeHarness: BuildServeHarness,
  store: SessionStore = fakeStore(),
  permissionOptionId: 'allow-once' | 'allow-always' | 'reject-once' = 'allow-once',
  runtime: ProviderRuntime = providerRuntime(),
): {
  client: ClientSideConnection
  updates: SessionNotification[]
  permissions: RequestPermissionRequest[]
} => {
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable)

  new AgentSideConnection((conn) => createHarnessAgent(conn, config, store, runtime, buildServeHarness), agentStream)

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

const restoreSpies: (() => void)[] = []
beforeAll(() => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(() => true)
  restoreSpies.push(() => consoleError.mockRestore(), () => stderrWrite.mockRestore())
})
afterAll(() => {
  for (const restore of restoreSpies) restore()
})

/** A fake harness whose prompt streams a text delta, asks to run `bash` (driving
 *  the permission round-trip), then reports the tool completing. */
const streamingBuilder: BuildServeHarness = async () => {
  let emit: (event: AgentHarnessEvent) => void = () => {}
  let gate: ((event: ToolCallEvent) => Promise<ToolCallResult | undefined>) | null = null
  return fakeHarness({
    subscribe: (listener) => {
      emit = listener
      return () => {
        emit = () => {}
      }
    },
    registerToolCallGate: (handler) => {
      gate = handler
    },
    prompt: async (text) => {
      emit({
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: `you said: ${text}`,
          partial: assistantMessage(),
        },
      })
      const decision = await gate?.({
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'bash',
        input: { command: 'echo hi' },
      })
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
      return assistantMessage()
    },
  })
}

describe('createHarnessAgent (ACP server)', () => {
  test('initialize advertises resume (not loadSession) and negotiates the protocol version', async () => {
    const { client } = connectPair(streamingBuilder)
    const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(init.agentCapabilities?.loadSession).toBe(false)
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toBeDefined()
    expect(init.agentCapabilities?._meta).toEqual(skillsCapabilityMeta)
    expect(init.agentInfo?.name).toBe('thunderbolt')
  })

  test('session/new and session/resume pass wire-delivered skills into harness config', async () => {
    const capturedSkills: Array<readonly SkillDefinition[]> = []
    const capturingBuilder: BuildServeHarness = async (harnessConfig) => {
      capturedSkills.push(harnessConfig.skills ?? [])
      return fakeHarness()
    }
    const skills: SkillDefinition[] = [
      {
        name: 'daily-brief',
        description: 'Build a concise daily rundown.',
        instruction: 'Gather current weather and calendar details.',
      },
    ]
    const meta = buildWireSkillsMeta(skills)
    const { client } = connectPair(capturingBuilder)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await client.newSession({ cwd: '/', mcpServers: [], _meta: meta })
    await client.resumeSession({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/',
      mcpServers: [],
      _meta: meta,
    })

    expect(capturedSkills).toEqual([skills, skills])
  })

  test('session/resume opens the stored session by id and injects it into the harness (no replay)', async () => {
    const store = fakeStore()
    const injected: PiSession[] = []
    const capturingBuilder: BuildServeHarness = async (_config, _binding, session) => {
      injected.push(session)
      return fakeHarness()
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
      return fakeHarness({
        dispose: async () => {
          disposed.push(id)
        },
      })
    }

    const threadId = '22222222-2222-4222-8222-222222222222'
    const { client } = connectPair(trackingBuilder)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await client.resumeSession({ sessionId: threadId, cwd: process.cwd(), mcpServers: [] })
    await client.resumeSession({ sessionId: threadId, cwd: process.cwd(), mcpServers: [] })

    // The first harness (id 0) was torn down when the second replaced it.
    expect(disposed).toEqual([0])
  })

  test('connection cleanup still disposes a session when its unsubscribe callback throws', async () => {
    const events: string[] = []
    const disposed = Promise.withResolvers<void>()
    const builder: BuildServeHarness = async () =>
      fakeHarness({
        subscribe: () => () => {
          events.push('unsubscribe')
          throw new Error('unsubscribe failed')
        },
        dispose: async () => {
          events.push('dispose')
          disposed.resolve()
        },
      })
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), providerRuntime(), builder),
    )

    await controlled.agent.newSession({ cwd: '/', mcpServers: [] })
    controlled.close()
    await disposed.promise

    expect(events).toEqual(['unsubscribe', 'dispose'])
  })

  test('disposes a candidate when event subscription fails before publication', async () => {
    let disposals = 0
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), providerRuntime(), async () =>
        fakeHarness({
          subscribe: () => {
            throw new Error('subscribe failed')
          },
          dispose: async () => {
            disposals += 1
          },
        }),
      ),
    )

    await expect(controlled.agent.newSession({ cwd: '/', mcpServers: [] })).rejects.toThrow('subscribe failed')
    expect(disposals).toBe(1)
    controlled.close()
  })

  test('unsubscribes and disposes a candidate when permission-gate wiring fails', async () => {
    const events: string[] = []
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), providerRuntime(), async () =>
        fakeHarness({
          subscribe: () => () => {
            events.push('unsubscribe')
          },
          registerToolCallGate: () => {
            throw new Error('gate failed')
          },
          dispose: async () => {
            events.push('dispose')
          },
        }),
      ),
    )

    await expect(controlled.agent.newSession({ cwd: '/', mcpServers: [] })).rejects.toThrow('gate failed')
    expect(events).toEqual(['unsubscribe', 'dispose'])
    controlled.close()
  })

  test('aggregates wiring and cleanup failures while keeping the candidate unpublished', async () => {
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), providerRuntime(), async () =>
        fakeHarness({
          subscribe: () => {
            throw new Error('subscribe failed')
          },
          dispose: async () => {
            throw new Error('dispose failed')
          },
        }),
      ),
    )

    const failure = await captureRejection(controlled.agent.newSession({ cwd: '/', mcpServers: [] }))

    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate wiring failure')
    expect(failure.errors.map((error) => String(error))).toEqual(['Error: subscribe failed', 'Error: dispose failed'])
    controlled.close()
  })

  test('failed replacement attempts every old and candidate cleanup without publishing the candidate', async () => {
    const events: string[] = []
    let build = 0
    const builder: BuildServeHarness = async () => {
      const id = build++
      return fakeHarness({
        subscribe: () => () => {
          events.push(`${id}:unsubscribe`)
          if (id === 0) throw new Error('old unsubscribe failed')
        },
        dispose: async () => {
          events.push(`${id}:dispose`)
          if (id === 0) throw new Error('old dispose failed')
        },
      })
    }
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), providerRuntime(), builder),
    )
    const sessionId = '22222222-2222-4222-8222-222222222222'
    if (!controlled.agent.resumeSession) throw new Error('ACP agent did not advertise resume')
    await controlled.agent.resumeSession({ sessionId, cwd: '/', mcpServers: [] })

    await expect(controlled.agent.resumeSession({ sessionId, cwd: '/', mcpServers: [] })).rejects.toBeInstanceOf(
      AggregateError,
    )

    expect(events).toEqual(['0:unsubscribe', '0:dispose', '1:unsubscribe', '1:dispose'])
    controlled.close()
  })

  test('new and resume concurrently prepare independent bindings and dispose both runtimes', async () => {
    const preparedSelections: Parameters<ProviderRuntime['prepare']>[0][] = []
    const bindings: PreparedPiBinding[] = []
    const disposals: string[] = []
    const receiptState: string[][] = []
    const allDisposed = Promise.withResolvers<void>()
    const runtime = providerRuntime(async (requested) => {
      preparedSelections.push(requested)
      const id = String(bindings.length)
      const binding = preparedBinding(id, async () => {
        disposals.push(id)
        if (disposals.length === 2) allDisposed.resolve()
      })
      bindings.push(binding)
      return binding
    })
    const harnessConfigs: Parameters<BuildServeHarness>[0][] = []
    const builtBindings: PreparedPiBinding[] = []
    const builder: BuildServeHarness = async (harnessConfig, binding) => {
      harnessConfigs.push(harnessConfig)
      builtBindings.push(binding)
      const receipts: string[] = []
      receiptState.push(receipts)
      return fakeHarness({
        prompt: async (text) => {
          await Promise.resolve()
          receipts.push(`${binding.providerId}:${text}`)
          return assistantMessage()
        },
        dispose: binding.dispose,
      })
    }
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), runtime, builder),
    )
    const { agent } = controlled
    const resumeId = '33333333-3333-4333-8333-333333333333'
    if (!agent.resumeSession) throw new Error('ACP agent did not advertise resume')

    const [fresh] = await Promise.all([
      agent.newSession({ cwd: '/', mcpServers: [] }),
      agent.resumeSession({ sessionId: resumeId, cwd: '/', mcpServers: [] }),
    ])
    await Promise.all([
      agent.prompt({ sessionId: fresh.sessionId, prompt: [{ type: 'text', text: 'fresh' }] }),
      agent.prompt({ sessionId: resumeId, prompt: [{ type: 'text', text: 'resumed' }] }),
    ])
    controlled.close()
    await allDisposed.promise

    expect(preparedSelections).toEqual([selection, selection])
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).not.toBe(bindings[1])
    expect(builtBindings).toEqual(bindings)
    expect(harnessConfigs).toEqual([
      expect.objectContaining({ cwd: await realpath(config.cwd) }),
      expect.objectContaining({ cwd: await realpath(config.cwd) }),
    ])
    for (const harnessConfig of harnessConfigs) {
      expect(harnessConfig).not.toHaveProperty('provider')
      expect(harnessConfig).not.toHaveProperty('baseUrl')
      expect(harnessConfig).not.toHaveProperty('apiKey')
    }
    expect(receiptState.flat().sort()).toEqual([
      `${bindings[0]?.providerId}:fresh`,
      `${bindings[1]?.providerId}:resumed`,
    ])
    expect(disposals.sort()).toEqual(['0', '1'])
  })

  test('connection close cancels a hanging session preparation and never builds a harness', async () => {
    const started = Promise.withResolvers<void>()
    const runtime = providerRuntime(async () => {
      started.resolve()
      return new Promise<PreparedPiBinding>(() => {})
    })
    let builds = 0
    const controlled = controlledAgent((connection) =>
      createHarnessAgent(connection, config, fakeStore(), runtime, async (_config, _binding, _session) => {
        builds += 1
        throw new Error('harness must not be built after connection close')
      }),
    )

    const pending = controlled.agent.newSession({ cwd: '/', mcpServers: [] })
    await started.promise
    controlled.close()

    await expect(pending).rejects.toBeDefined()
    expect(builds).toBe(0)
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

  test('uses the complete HarnessRuntime prompt operation and remains available after an error', async () => {
    const promptTexts: string[] = []
    let prepareCalls = 0
    const runtime = providerRuntime(async () => {
      prepareCalls += 1
      return preparedBinding('prompt-error')
    })
    const builder: BuildServeHarness = async () =>
      fakeHarness({
        prompt: async (text) => {
          promptTexts.push(text)
          if (promptTexts.length === 1) {
            return { ...assistantMessage('error'), errorMessage: 'OpenAI API error (401): expired credential' }
          }
          return assistantMessage()
        },
      })
    const { client } = connectPair(builder, fakeStore(), 'allow-once', runtime)
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: '/', mcpServers: [] })

    await expect(client.prompt({ sessionId, prompt: [{ type: 'text', text: 'fail exactly once' }] })).rejects.toThrow(
      'Internal error',
    )
    const recovered = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'still available' }] })

    expect(recovered.stopReason).toBe('end_turn')
    expect(promptTexts).toEqual(['fail exactly once', 'still available'])
    expect(prepareCalls).toBe(1)
  })

  test('session/new ignores client cwd and binds store plus harness to trusted launch directory', async () => {
    const store = fakeStore()
    const harnessCwds: string[] = []
    const capturingBuilder: BuildServeHarness = async (harnessConfig, binding, session) => {
      harnessCwds.push(harnessConfig.cwd)
      return streamingBuilder(harnessConfig, binding, session)
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
      return fakeHarness({
        registerToolCallGate: (handler) => {
          gate = handler
        },
        prompt: async () => {
          decisions.push(
            await gate?.({
              type: 'tool_call',
              toolCallId: 'inside',
              toolName: 'read',
              input: { path: 'package.json' },
            }),
          )
          decisions.push(
            await gate?.({
              type: 'tool_call',
              toolCallId: 'outside-1',
              toolName: 'read',
              input: { path: '/etc/passwd' },
            }),
          )
          decisions.push(
            await gate?.({
              type: 'tool_call',
              toolCallId: 'outside-2',
              toolName: 'read',
              input: { path: '/etc/passwd' },
            }),
          )
          return assistantMessage()
        },
      })
    }

    const { client, permissions } = connectPair(readBuilder, fakeStore(), 'allow-always')
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: '/', mcpServers: [] })
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'read' }] })

    expect(permissions.map((request) => request.toolCall.toolCallId)).toEqual(['outside-1', 'outside-2'])
    expect(decisions).toEqual([undefined, undefined, undefined])
  })

  test('webfetch and skill are auto-allowed without prompting while bash stays gated', async () => {
    const decisions: Array<ToolCallResult | undefined> = []
    const webBuilder: BuildServeHarness = async () => {
      let gate: ((event: ToolCallEvent) => Promise<ToolCallResult | undefined>) | null = null
      return fakeHarness({
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
            await gate?.({
              type: 'tool_call',
              toolCallId: 'skill',
              toolName: 'skill',
              input: { name: 'daily-brief' },
            }),
          )
          decisions.push(
            await gate?.({ type: 'tool_call', toolCallId: 'shell', toolName: 'bash', input: { command: 'curl x' } }),
          )
          return assistantMessage()
        },
      })
    }

    const { client, permissions } = connectPair(webBuilder, fakeStore(), 'reject-once')
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await client.newSession({ cwd: '/', mcpServers: [] })
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'web' }] })

    expect(decisions).toEqual([undefined, undefined, { block: true, reason: 'user rejected bash' }])
    expect(permissions.map((request) => request.toolCall.toolCallId)).toEqual(['shell'])
  })

  test('a denied permission blocks the tool and the model never sees it run', async () => {
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    new AgentSideConnection(
      (conn) => createHarnessAgent(conn, config, fakeStore(), providerRuntime(), streamingBuilder),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    )
    const updates: SessionNotification[] = []
    const denyingClient: Client = {
      sessionUpdate: async (params) => {
        updates.push(params)
      },
      requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } }),
    }
    const client = new ClientSideConnection(
      () => denyingClient,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    )

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
    const cancellingBuilder: BuildServeHarness = async () =>
      fakeHarness({
        prompt: async () => {
          if (!abortedEarly) await new Promise<void>((resolve) => (release = resolve))
          return assistantMessage('aborted')
        },
        abort: async () => {
          abortedEarly = true
          release?.()
        },
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
