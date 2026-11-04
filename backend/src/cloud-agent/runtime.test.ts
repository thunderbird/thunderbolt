/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import postgres from 'postgres'
import {
  generateResourceKey,
  generateResourceIdentity,
  type ResourceKeyEnvelope,
  type ScopedCiphertext,
} from '@shared/cloud-agent/crypto'
import type { CloudMessageContent } from '@shared/cloud-agent/contracts'
import { createCloudRuntime, type CloudRuntime, type LoadedCloudRun, type RuntimeHost } from './runtime'
import { openPostgresRuntimeStore } from './storage'
import { CloudError } from './errors'

const databaseUrl = process.env.CLOUD_AGENT_TEST_DATABASE_URL
const suite = databaseUrl ? describe : describe.skip
const cipher: ScopedCiphertext = { version: 1, kind: 'scoped-payload', iv: 'fixture', ciphertext: 'fixture' }
const envelope: ResourceKeyEnvelope = {
  version: 1,
  kind: 'resource-key',
  recipientKeyId: 'fixture',
  ephemeralPublicKey: 'fixture',
  mlkemCiphertext: 'fixture',
  iv: 'fixture',
  ciphertext: 'fixture',
}

/** A protocol-level fake exercises the real Pi provider and harness without network access. */
const response = (text: string, tool?: string): Response => {
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: tool, arguments: '{}' } }],
      }
    : { role: 'assistant', content: text }
  const chunks = [
    {
      id: 'completion-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id: 'completion-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}
const waitUntil = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Condition timed out')
    }
    await Bun.sleep(10)
  }
}

suite('cloud Pi runtime over encrypted Postgres', () => {
  const namespaces = new Set<string>()
  const sql = postgres(databaseUrl!, { max: 1 })
  const runtimes = new Set<CloudRuntime>()
  afterAll(async () => {
    for (const runtime of runtimes) {
      await runtime.close()
    }
    for (const namespace of namespaces) {
      await sql`DELETE FROM cloud_runtime_namespaces WHERE namespace = ${namespace}`
    }
    await sql.end()
  })

  const fixture = async (
    options: {
      tools?: ToolRegistration[]
      toolInstructions?: string
      reply?: (body: string, call: number) => Response
      beforeTool?: RuntimeHost['beforeTool']
      failProjection?: () => boolean
    } = {},
  ) => {
    const agentId = `runtime-test-${crypto.randomUUID()}`
    namespaces.add(`agent:${agentId}`)
    const now = new Date().toISOString()
    const key = await generateResourceKey()
    const ownerIdentity = await generateResourceIdentity()
    const records = new Map<string, LoadedCloudRun>()
    const messages = new Map<string, CloudMessageContent>()
    const requests: string[] = []
    const transitions: string[] = []
    const addRun = (text: string, conversationId: string = crypto.randomUUID()): LoadedCloudRun => {
      const id = crypto.randomUUID()
      const loaded: LoadedCloudRun = {
        agent: {
          id: agentId,
          userId: 'test-owner',
          version: 1,
          keyEpoch: 1,
          saveDigest: null,
          enabled: true,
          config: cipher,
          ownerKeyEnvelope: envelope,
          runtimeKeyEnvelope: envelope,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        run: {
          id,
          userId: 'test-owner',
          agentId,
          conversationId,
          commandId: crypto.randomUUID(),
          commandDigest: 'fixture',
          content: cipher,
          keyEpoch: 1,
          configVersion: 1,
          config: cipher,
          status: 'queued',
          piSubmissionId: null,
          errorCode: null,
          reservedMicros: 1_000_000,
          spentMicros: 0,
          createdAt: now,
          updatedAt: now,
        },
        config: {
          ownerRecipient: ownerIdentity.publicKey,
          name: 'Test agent',
          description: '',
          instructions: 'Always mention the orchard.',
          model: { provider: 'openai-compatible', modelId: 'fixture', contextWindow: 32768, maxOutputTokens: 128 },
          skills: [{ name: 'Gardening', description: 'Garden advice', instruction: 'Explain soil drainage.' }],
          connectionIds: [],
          searchEnabled: false,
          approvalMode: 'full-access',
          maxSteps: 5,
          maxRunCostUsd: 1,
        },
        key,
        text,
        piConversationId: null,
      }
      records.set(id, loaded)
      return loaded
    }
    const get = (id: string) => {
      const record = records.get(id)
      if (!record) {
        throw new Error('Unknown fixture run')
      }
      return record
    }
    const host: RuntimeHost = {
      loadRun: async (id) => get(id),
      setStatus: async (id, status, code) => {
        get(id).run.status = status
        get(id).run.errorCode = code ?? null
        transitions.push(status)
      },
      appendMessage: async (id, logicalId, content) => {
        if (options.failProjection?.()) {
          throw new Error('Projection unavailable')
        }
        messages.set(`${id}:${logicalId}`, content)
      },
      beforeTool: options.beforeTool ?? (async () => {}),
      checkExecution: async (id) => {
        if (get(id).run.status === 'stop-requested') {
          throw new CloudError(409, 'run_stopped')
        }
      },
      settleCost: async (id, cost) => {
        get(id).run.spentMicros = cost
        transitions.push('cost-settled')
      },
      bindConversation: async (id, piId) => {
        get(id).piConversationId = piId
      },
      bindSubmission: async (id, piId) => {
        get(id).run.piSubmissionId = piId
      },
      activeRunIds: async () =>
        [...records.values()]
          .filter((record) => ['running', 'awaiting-approval', 'stop-requested'].includes(record.run.status))
          .map((record) => record.run.id),
      createTools: async () => ({ tools: options.tools ?? [], instructions: options.toolInstructions }),
      resolveModel: async () => ({
        apiKey: 'fixture-key',
        baseUrl: 'https://fixture.invalid/v1',
        cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
        fetch: Object.assign(
          async (_input: string | URL | Request, init?: RequestInit) => {
            const body = String(init?.body ?? '')
            requests.push(body)
            return options.reply?.(body, requests.length) ?? response('The orchard has good soil drainage.')
          },
          { preconnect: () => {} },
        ),
      }),
    }
    const open = async () => {
      const store = await openPostgresRuntimeStore({ connectionString: databaseUrl! })
      const runtime = createCloudRuntime(store, host)
      runtimes.add(runtime)
      return runtime
    }
    const close = async (runtime: CloudRuntime) => {
      await runtime.close()
      runtimes.delete(runtime)
    }
    return { addRun, get, requests, messages, transitions, open, close }
  }

  it('sends versioned instructions and skills, projects once, and retains conversation history after reopening', async () => {
    const test = await fixture({ toolInstructions: 'Local garden sensors are unavailable in Cloud.' })
    const first = test.addRun('How should I plant the apple trees?')
    const runtime = await test.open()
    await runtime.run(first.run.id)
    expect(first.run.errorCode).toBeNull()
    expect(first.run.status).toBe('completed')
    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]).toContain('Always mention the orchard.')
    expect(test.requests[0]).toContain('Explain soil drainage.')
    expect(test.requests[0]).toContain('Local garden sensors are unavailable in Cloud.')
    expect([...test.messages.values()].map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(test.transitions.indexOf('cost-settled')).toBeLessThan(test.transitions.indexOf('completed'))
    expect(first.run.spentMicros).toBe(20)
    await test.close(runtime)
    const second = test.addRun('And pears?', first.run.conversationId)
    const reopened = await test.open()
    await reopened.run(second.run.id)
    expect(second.run.status).toBe('completed')
    expect(second.piConversationId).toBe(first.piConversationId)
    expect(test.requests[1]).toContain('apple trees')
    expect(test.requests[1]).toContain('And pears?')
    expect(test.messages.size).toBe(4)
    await test.close(reopened)
  }, 10000)

  it('continues tool turns with unlimited steps and cost while retaining usage accounting', async () => {
    const test = await fixture({
      tools: [
        defineTool({
          name: 'record',
          description: 'Record',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async () => ({ output: [{ type: 'text', text: 'Done' }] }),
        }),
      ],
      reply: (_body, call) => (call === 1 ? response('', 'record') : response('Complete')),
    })
    const loaded = test.addRun('Run a tool then answer')
    loaded.config.maxSteps = null
    loaded.config.maxRunCostUsd = null
    const runtime = await test.open()
    await runtime.run(loaded.run.id)
    expect(test.requests).toHaveLength(2)
    expect(loaded.run.status).toBe('completed')
    await test.close(runtime)
  }, 10000)

  it('enforces a persisted model-step limit before sending the next request', async () => {
    const actions: string[] = []
    const test = await fixture({
      tools: [
        defineTool({
          name: 'record',
          description: 'Record a result',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async () => {
            actions.push('executed')
            return { output: [{ type: 'text', text: 'Recorded' }] }
          },
        }),
      ],
      reply: () => response('', 'record'),
    })
    const loaded = test.addRun('Record the result')
    loaded.config.maxSteps = 1
    const runtime = await test.open()
    await runtime.run(loaded.run.id)
    expect(test.requests).toHaveLength(1)
    expect(actions).toEqual(['executed'])
    expect(loaded.run.status).toBe('blocked')
    expect(loaded.run.errorCode).toBe('step_limit_reached')
    await test.close(runtime)
  }, 10000)

  it('refuses an unaffordable request before external dispatch', async () => {
    const test = await fixture()
    const loaded = test.addRun('Hello')
    loaded.config.maxRunCostUsd = 0.000001
    const runtime = await test.open()
    await runtime.run(loaded.run.id)
    expect(test.requests).toHaveLength(0)
    expect(loaded.run.errorCode).toBe('run_budget_exceeded')
    expect(loaded.run.spentMicros).toBe(0)
    await test.close(runtime)
  }, 10000)

  it('suspends at approval and resumes without duplicating the input or tool effect', async () => {
    const state = { waiting: false, approved: false, effects: 0 }
    const test = await fixture({
      beforeTool: async (_id, _call, _name, _args, signal) => {
        if (state.approved) {
          return
        }
        state.waiting = true
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason)
          } else {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }
        })
      },
      tools: [
        defineTool({
          name: 'record',
          description: 'Record a result',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async () => {
            state.effects++
            return { output: [{ type: 'text', text: 'Recorded' }] }
          },
        }),
      ],
      reply: (_body, call) => (call === 1 ? response('', 'record') : response('Finished')),
    })
    const loaded = test.addRun('Record the result')
    const runtime = await test.open()
    const pending = runtime.run(loaded.run.id)
    await waitUntil(() => state.waiting)
    await test.close(runtime)
    await pending
    expect(loaded.run.status).toBe('running')
    expect(state.effects).toBe(0)
    state.approved = true
    const resumed = await test.open()
    await resumed.run(loaded.run.id)
    expect(loaded.run.status).toBe('completed')
    expect(state.effects).toBe(1)
    expect(test.requests).toHaveLength(2)
    expect([...test.messages.values()].filter((message) => message.role === 'user')).toHaveLength(1)
    await test.close(resumed)
  }, 10000)

  it('reconciles a committed answer after a projection outage without another provider request', async () => {
    const state = { unavailable: true }
    const test = await fixture({ failProjection: () => state.unavailable })
    const loaded = test.addRun('Hello')
    const runtime = await test.open()
    await expect(runtime.run(loaded.run.id)).rejects.toThrow('Projection unavailable')
    expect(loaded.run.status).toBe('running')
    expect(test.requests).toHaveLength(1)
    await test.close(runtime)
    state.unavailable = false
    const resumed = await test.open()
    await resumed.run(loaded.run.id)
    expect(loaded.run.status).toBe('completed')
    expect(test.requests).toHaveLength(1)
    expect(test.messages.size).toBe(2)
    await test.close(resumed)
  }, 10000)

  it('reserves uncertain model charges and disables transport retries', async () => {
    const test = await fixture({ reply: () => new Response('Unavailable', { status: 503 }) })
    const loaded = test.addRun('Hello')
    const runtime = await test.open()
    await runtime.run(loaded.run.id)
    expect(test.requests).toHaveLength(1)
    expect(loaded.run.status).toBe('failed')
    expect(loaded.run.spentMicros).toBeGreaterThan(4000)
    await test.close(runtime)
  }, 10000)

  it('persists ambiguous live tool outcomes and blocks retries even after projection recovery', async () => {
    const state = { effects: 0, projectionUnavailable: true }
    const test = await fixture({
      failProjection: () => state.projectionUnavailable,
      tools: [
        defineTool({
          name: 'external_action',
          description: 'Perform an external action',
          parameters: Type.Object({}),
          replay: 'unsafe',
          execute: async () => {
            state.effects++
            throw new CloudError(409, 'tool_outcome_uncertain')
          },
        }),
      ],
      reply: () => response('', 'external_action'),
    })
    const loaded = test.addRun('Perform the action')
    const runtime = await test.open()
    await expect(runtime.run(loaded.run.id)).rejects.toThrow('Projection unavailable')
    await test.close(runtime)
    state.projectionUnavailable = false
    const resumed = await test.open()
    await resumed.run(loaded.run.id)
    expect(loaded.run.status).toBe('uncertain')
    expect(loaded.run.errorCode).toBe('tool_outcome_uncertain')
    expect(state.effects).toBe(1)
    expect(test.requests).toHaveLength(1)
    expect(
      [...test.messages.values()].some(
        (message) => message.role === 'tool' && message.text.includes('could not be confirmed'),
      ),
    ).toBe(true)
    await test.close(resumed)
  }, 10000)

  it('treats a returned tool error as a known outcome rather than an uncertain dispatch', async () => {
    const test = await fixture({
      tools: [
        defineTool({
          name: 'external_action',
          description: 'Perform an external action',
          parameters: Type.Object({}),
          replay: 'unsafe',
          execute: async () => ({
            isError: true,
            output: [{ type: 'text', text: 'Request rejected by the remote service.' }],
          }),
        }),
      ],
      reply: (_body, call) =>
        call === 1 ? response('', 'external_action') : response('The remote service rejected the request.'),
    })
    const loaded = test.addRun('Perform the action')
    const runtime = await test.open()
    await runtime.run(loaded.run.id)
    expect(loaded.run.status).toBe('completed')
    expect(test.requests).toHaveLength(2)
    await test.close(runtime)
  }, 10000)

  it('does not dispatch preloaded recovering runs before their scheduler admission', async () => {
    const state = { waiting: 0, approved: false, effects: 0 }
    const test = await fixture({
      beforeTool: async (_id, _call, _name, _args, signal) => {
        if (state.approved) {
          return
        }
        state.waiting++
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      tools: [
        defineTool({
          name: 'record',
          description: 'Record a result',
          parameters: Type.Object({}),
          replay: 'safe',
          execute: async () => {
            state.effects++
            return { output: [{ type: 'text', text: 'Recorded' }] }
          },
        }),
      ],
      reply: (body) => (body.includes('Recorded') ? response('Finished') : response('', 'record')),
    })
    const first = test.addRun('First')
    const second = test.addRun('Second')
    const runtime = await test.open()
    const tasks = [runtime.run(first.run.id), runtime.run(second.run.id)]
    await waitUntil(() => state.waiting === 2)
    await test.close(runtime)
    await Promise.all(tasks)
    state.approved = true
    const resumed = await test.open()
    await resumed.run(first.run.id)
    expect(first.run.status).toBe('completed')
    expect(second.run.status).toBe('running')
    expect(state.effects).toBe(1)
    expect(test.requests).toHaveLength(3)
    await resumed.run(second.run.id)
    expect(second.run.status).toBe('completed')
    expect(state.effects).toBe(2)
    expect(test.requests).toHaveLength(4)
    await test.close(resumed)
  }, 10000)

  it('surfaces an interrupted unsafe action as uncertain and prevents another model request', async () => {
    const state = { effects: 0 }
    const test = await fixture({
      tools: [
        defineTool({
          name: 'external_action',
          description: 'Perform an external action',
          parameters: Type.Object({}),
          replay: 'unsafe',
          execute: async (_args, _api, context) => {
            state.effects++
            await new Promise<void>((_resolve, reject) => {
              context.abortSignal?.addEventListener('abort', () => reject(context.abortSignal!.reason), { once: true })
            })
            return { output: [{ type: 'text', text: 'Done' }] }
          },
        }),
      ],
      reply: () => response('', 'external_action'),
    })
    const loaded = test.addRun('Perform the action')
    const runtime = await test.open()
    const pending = runtime.run(loaded.run.id)
    await waitUntil(() => state.effects === 1)
    await test.close(runtime)
    await pending
    const resumed = await test.open()
    await resumed.run(loaded.run.id)
    expect(loaded.run.status).toBe('uncertain')
    expect(loaded.run.errorCode).toBe('tool_outcome_uncertain')
    expect(state.effects).toBe(1)
    expect(test.requests).toHaveLength(1)
    expect(
      [...test.messages.values()].some((message) => message.role === 'tool' && message.text.includes('interrupted')),
    ).toBe(true)
    await test.close(resumed)
  }, 10000)
})
