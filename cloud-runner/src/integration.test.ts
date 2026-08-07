/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * End-to-end protocol tests over real wire plumbing: the actual runner server
 * (WebSocket + bearer auth + harness) against a stub backend that plays both
 * roles the real one does — token introspection (`/v1/api/auth/get-session`)
 * and the inference gateway (`/v1/chat/completions`). The gateway stub records
 * which user's bearer authenticated each model call and which model it asked
 * for, which is the whole point of the runner holding neither provider keys nor
 * a model opinion.
 *
 * The flagship case is a prompt turn surviving its client disconnecting
 * mid-stream; the stub streams a sentence slowly enough to drop a connection
 * in the middle of one.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientSideConnection } from '@agentclientprotocol/sdk'
import type { AnyMessage, SessionNotification } from '@agentclientprotocol/sdk'
import type { Server } from 'bun'
import {
  buildRunSpecMeta,
  runnerAwaitTurnMethod,
  runnerDeleteSessionMethod,
  runnerReplayMethod,
  type RunnerAwaitTurnResponse,
  type RunnerReplayResponse,
  type RunSpec,
} from '../../shared/acp-types.ts'
import { renderHtmlToolName, type RenderHtmlInput } from '../../shared/artifacts/render-html-contract.ts'
import { encodeWsBearer, wsBearerSubprotocolPrefix, wsCarrierSubprotocol } from '../../shared/ws-bearer.ts'
import type { RunnerConfig } from './config.ts'
import { startServer, wsCloseUnauthorized, type RunnerServer } from './server.ts'
import { createSessionRegistry, type SessionRegistry } from './session-runtime.ts'

const sentence = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog.']
const fullSentence = sentence.join('')
const deltaIntervalMs = 60

const encoder = new TextEncoder()

const tokenA = 'token-user-a'
const tokenB = 'token-user-b'

/** The two model ids the stub gateway serves — stand-ins for whatever ids the
 *  real gateway accepts. The runner passes them through untouched. */
const specA: RunSpec = { modelId: 'stub-model-a', thinkingLevel: 'medium' }
const specB: RunSpec = { modelId: 'stub-model-b', thinkingLevel: 'low' }
const knownModels = new Set([specA.modelId, specB.modelId])

/** One recorded inference-gateway call. */
type CompletionCall = {
  readonly auth: string
  readonly model: string
  /** Serialized request messages, so a test can assert prior turns are present. */
  readonly messages: string
}

type BackendStub = {
  readonly server: Server<never>
  readonly url: string
  /** Bearer -> user id. Deleting an entry revokes the token. */
  readonly tokens: Map<string, string>
  /** Bearers the inference gateway answers with 401 (expired mid-turn). */
  readonly gatewayRejects: Set<string>
  /** Every completions call, in order. */
  readonly completions: CompletionCall[]
  /** Set `input` to make the model open each turn with a `render_html` call
   *  carrying it, then answer the tool result with the plain sentence. */
  readonly artifact: { input: RenderHtmlInput | null }
}

const sse = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)

const chunkOf =
  (model: string) =>
  (delta: Record<string, unknown>, finishReason: string | null = null): Uint8Array =>
    sse({
      id: 'cmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })

/** SSE frames for a single `render_html` tool call, OpenAI chunk shape. */
const toolCallStream = (model: string, input: RenderHtmlInput): ReadableStream<Uint8Array> => {
  const chunk = chunkOf(model)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-artifact',
              type: 'function',
              function: { name: renderHtmlToolName, arguments: JSON.stringify(input) },
            },
          ],
        }),
      )
      controller.enqueue(chunk({}, 'tool_calls'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/** SSE frames for one slow assistant sentence, OpenAI chunk shape. */
const sentenceStream = (model: string): ReadableStream<Uint8Array> => {
  const chunk = chunkOf(model)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(chunk({ role: 'assistant' }))
      for (const word of sentence) {
        await Bun.sleep(deltaIntervalMs)
        controller.enqueue(chunk({ content: word }))
      }
      controller.enqueue(chunk({}, 'stop'))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/** Stub backend: Better Auth introspection plus the inference gateway. */
const createBackendStub = (): BackendStub => {
  const tokens = new Map([
    [tokenA, 'user-a'],
    [tokenB, 'user-b'],
  ])
  const gatewayRejects = new Set<string>()
  const completions: CompletionCall[] = []
  const artifact: { input: RenderHtmlInput | null } = { input: null }
  const bearerOf = (request: Request): string => (request.headers.get('authorization') ?? '').replace('Bearer ', '')

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const bearer = bearerOf(request)
      if (url.pathname === '/v1/api/auth/get-session') {
        const userId = tokens.get(bearer)
        return Response.json(
          userId ? { user: { id: userId, email: `${userId}@example.com`, isAnonymous: false } } : null,
        )
      }
      if (url.pathname === '/v1/chat/completions') {
        const body = (await request.json()) as { model?: unknown; messages?: unknown }
        const model = typeof body.model === 'string' ? body.model : ''
        const messages = JSON.stringify(body.messages ?? [])
        completions.push({ auth: request.headers.get('authorization') ?? '', model, messages })
        if (!tokens.has(bearer) || gatewayRejects.has(bearer)) {
          return Response.json({ error: { message: 'invalid bearer' } }, { status: 401 })
        }
        if (!knownModels.has(model)) {
          return Response.json({ error: { message: `unknown model '${model}'` } }, { status: 400 })
        }
        const sseHeaders = { headers: { 'content-type': 'text/event-stream' } }
        // The tool call goes out once per turn: after it, the request carries its
        // result, which is the cue to finish with prose. The cue is the call id
        // (only ever present once the call is in the transcript) — the tool NAME
        // also appears in the system prompt, so matching on it would misfire.
        if (artifact.input && !messages.includes('call-artifact')) {
          return new Response(toolCallStream(model, artifact.input), sseHeaders)
        }
        return new Response(sentenceStream(model), sseHeaders)
      }
      return new Response('not found', { status: 404 })
    },
  })

  return { server, url: `http://localhost:${server.port}`, tokens, gatewayRejects, completions, artifact }
}

type Rig = {
  readonly backend: BackendStub
  readonly registry: SessionRegistry
  readonly runner: RunnerServer
  readonly port: number
  readonly dataDir: string
}

/** Boot a stub backend and a runner wired to it, on ephemeral ports. */
const startRig = async (overrides: Partial<RunnerConfig> = {}): Promise<Rig> => {
  const backend = createBackendStub()
  const dataDir = await mkdtemp(join(tmpdir(), 'tb-cloud-runner-test-'))
  const config: RunnerConfig = {
    port: 0,
    backendUrl: backend.url,
    dataDir,
    idleSessionTtlMs: 60_000,
    revalidateIntervalMs: 60_000,
    maxSessionsPerUser: 20,
    maxConcurrentTurnsPerUser: 3,
    retentionMs: 60_000,
    ...overrides,
  }
  const registry = createSessionRegistry(config)
  const runner = startServer(config, registry)
  return { backend, registry, runner, port: Number(runner.server.port), dataDir }
}

const stopRig = async (rig: Rig): Promise<void> => {
  rig.runner.stop()
  rig.backend.server.stop(true)
  await rig.registry.disposeAll()
  await rm(rig.dataDir, { recursive: true, force: true })
}

type TestClient = {
  ws: WebSocket
  conn: ClientSideConnection
  updates: SessionNotification[]
  closed: Promise<{ code: number }>
}

/** Open an authenticated ACP client against the runner (app-identical framing:
 *  one JSON-RPC object per WebSocket message, bearer via subprotocol). */
const connectClient = (port: number, bearer: string): Promise<TestClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/`, [
      wsCarrierSubprotocol,
      `${wsBearerSubprotocolPrefix}${encodeWsBearer(bearer)}`,
    ])
    const updates: SessionNotification[] = []
    let controller: ReadableStreamDefaultController<AnyMessage> | null = null
    let readableClosed = false
    const readable = new ReadableStream<AnyMessage>({
      start(c) {
        controller = c
      },
    })
    const writable = new WritableStream<AnyMessage>({
      write(message) {
        ws.send(JSON.stringify(message))
      },
    })
    let settleClosed: (value: { code: number }) => void = () => {}
    const closed = new Promise<{ code: number }>((res) => {
      settleClosed = res
    })
    ws.onmessage = (event) => {
      if (!readableClosed) controller?.enqueue(JSON.parse(String(event.data)) as AnyMessage)
    }
    ws.onclose = (event) => {
      if (!readableClosed) {
        readableClosed = true
        controller?.close()
      }
      settleClosed({ code: event.code })
    }
    ws.onerror = () => reject(new Error('websocket error'))
    ws.onopen = () => {
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: async (notification) => {
            updates.push(notification)
          },
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        }),
        { readable, writable },
      )
      resolve({ ws, conn, updates, closed })
    }
  })

/** Connect and complete the ACP handshake. */
const connectReady = async (port: number, bearer: string): Promise<TestClient> => {
  const client = await connectClient(port, bearer)
  await client.conn.initialize({
    protocolVersion: 1,
    clientInfo: { name: 'integration-test', version: '0' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })
  return client
}

const newSession = (client: TestClient, spec: RunSpec = specA) =>
  client.conn.newSession({ cwd: '.', mcpServers: [], _meta: buildRunSpecMeta(spec) })

const resumeSession = (client: TestClient, sessionId: string, spec: RunSpec = specA) =>
  client.conn.resumeSession({ sessionId, cwd: '.', mcpServers: [], _meta: buildRunSpecMeta(spec) })

const promptOf = (client: TestClient, sessionId: string, spec: RunSpec = specA) =>
  client.conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'say the sentence' }],
    _meta: buildRunSpecMeta(spec),
  })

/** Call one of the runner's session-scoped extension methods. The SDK types
 *  extension results as an opaque record, so the response shape is asserted
 *  here once instead of at every call site. */
const extCall = async <T>(client: TestClient, method: string, sessionId: string): Promise<T> =>
  (await client.conn.extMethod(method, { sessionId })) as T

const replayOf = (client: TestClient, sessionId: string): Promise<RunnerReplayResponse> =>
  extCall(client, runnerReplayMethod, sessionId)

const awaitTurnOf = (client: TestClient, sessionId: string): Promise<RunnerAwaitTurnResponse> =>
  extCall(client, runnerAwaitTurnMethod, sessionId)

/** Concatenate the text of every `agent_message_chunk` seen by a client. */
const textOf = (updates: SessionNotification[]): string =>
  updates
    .map((n) =>
      n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' ? n.update.content.text : '',
    )
    .join('')

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(20)
  }
}

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => null)) !== null

/** True while any of the session's on-disk state (workspace or entry log) remains. */
const sessionOnDisk = async (dataDir: string, userId: string, sessionId: string): Promise<boolean> => {
  const logs = await Array.fromAsync(new Bun.Glob(`sessions/**/*_${sessionId}.jsonl`).scan({ cwd: dataDir }))
  return logs.length > 0 || (await exists(join(dataDir, 'workspaces', userId, sessionId)))
}

describe('detached turns over the real wire', () => {
  let rig: Rig

  afterEach(async () => {
    await stopRig(rig)
  })

  test('an invalid bearer is refused with the unauthorized close code', async () => {
    rig = await startRig()
    const client = await connectClient(rig.port, 'bogus-token')
    expect((await client.closed).code).toBe(wsCloseUnauthorized)
  })

  test('a turn survives its client disconnecting and a reconnecting client replays it fully', async () => {
    rig = await startRig()
    // Client A starts a turn and drops mid-stream ("tab closed").
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a)
    const prompt = promptOf(a, sessionId)
    prompt.catch(() => {})

    await waitFor(() => textOf(a.updates).length > 0)
    a.ws.close()
    expect(textOf(a.updates).length).toBeLessThan(fullSentence.length)

    // Client B reconnects, resumes, replays the turn, and awaits its end.
    const b = await connectReady(rig.port, tokenA)
    await resumeSession(b, sessionId)
    const replay = await replayOf(b, sessionId)
    expect(replay.turn).not.toBeNull()

    const end = await awaitTurnOf(b, sessionId)
    expect(end.turn?.stopReason).toBe('end_turn')
    expect(end.turn?.errorMessage).toBeNull()

    // Everything the model produced arrives exactly once: the replayed prefix
    // plus the live suffix reassemble the full sentence.
    await waitFor(() => textOf(b.updates) === fullSentence)
    expect(textOf(b.updates)).toBe(fullSentence)

    // The gateway saw the session owner's own bearer and the client's own model,
    // never a runner-held key or a runner-chosen model.
    expect(rig.backend.completions).toMatchObject([{ auth: `Bearer ${tokenA}`, model: specA.modelId }])
    b.ws.close()
  })

  test('two connections observing one session both receive its live updates', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a)

    // A second tab/device resumes the same session while the first stays open.
    const b = await connectReady(rig.port, tokenA)
    await resumeSession(b, sessionId)

    await promptOf(a, sessionId)
    await waitFor(() => textOf(b.updates) === fullSentence)
    expect(textOf(a.updates)).toBe(fullSentence)
    expect(textOf(b.updates)).toBe(fullSentence)
    // One model call served both observers.
    expect(rig.backend.completions).toHaveLength(1)

    a.ws.close()
    b.ws.close()
  })

  test('each turn reaches the gateway with its own owner’s bearer', async () => {
    rig = await startRig()
    const b = await connectReady(rig.port, tokenB)
    const { sessionId } = await newSession(b)
    await promptOf(b, sessionId)

    expect(rig.backend.completions.map((call) => call.auth)).toEqual([`Bearer ${tokenB}`])
    b.ws.close()
  })

  test('a bearer the gateway rejects fails the turn cleanly', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a)
    rig.backend.gatewayRejects.add(tokenA)

    await expect(promptOf(a, sessionId)).rejects.toThrow()
    const end = await awaitTurnOf(a, sessionId)
    expect(end.turn?.errorMessage).toBeTruthy()
    expect(end.turn?.stopReason).toBeNull()

    // The failure is terminal for that turn: no retry storm against the gateway.
    expect(rig.backend.completions).toHaveLength(1)
    a.ws.close()
  })

  test('a reconnecting client replays a render_html call with its HTML and verdict intact', async () => {
    rig = await startRig()
    const input: RenderHtmlInput = {
      html: '<!doctype html><html><head><style>.a{color:red}</style></head><body><script>void 0</script></body></html>',
      title: 'Sales dashboard',
    }
    rig.backend.artifact.input = input

    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a)
    await promptOf(a, sessionId)
    a.ws.close()

    // A later client sees the whole artifact from the journal alone: the input
    // carries the HTML it renders, the output the verdict that gates rendering.
    const b = await connectReady(rig.port, tokenA)
    await resumeSession(b, sessionId)
    await replayOf(b, sessionId)

    const updates = b.updates.map((notification) => notification.update)
    expect(updates.find((update) => update.sessionUpdate === 'tool_call')).toMatchObject({
      title: renderHtmlToolName,
      rawInput: input,
    })
    expect(updates.find((update) => update.sessionUpdate === 'tool_call_update')).toMatchObject({
      status: 'completed',
      rawOutput: { ok: true },
    })

    b.ws.close()
  })

  test('a session cannot be resumed or replayed by another user', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a)

    const b = await connectReady(rig.port, tokenB)
    await expect(resumeSession(b, sessionId)).rejects.toThrow()
    await expect(b.conn.extMethod(runnerReplayMethod, { sessionId })).rejects.toThrow()

    a.ws.close()
    b.ws.close()
  })
})

describe('client-selected model and thinking level', () => {
  let rig: Rig

  afterEach(async () => {
    await stopRig(rig)
  })

  test('session/new, session/resume and session/prompt all require a run spec', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)

    await expect(a.conn.newSession({ cwd: '.', mcpServers: [] })).rejects.toThrow(/run spec/)
    await expect(
      a.conn.newSession({ cwd: '.', mcpServers: [], _meta: { 'thunderbird.net/thunderbolt': { run: { modelId: 1 } } } }),
    ).rejects.toThrow(/run spec/)

    const { sessionId } = await newSession(a)
    await expect(a.conn.resumeSession({ sessionId, cwd: '.', mcpServers: [] })).rejects.toThrow(/run spec/)
    await expect(
      a.conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow(/run spec/)

    // Nothing reached the gateway: the runner has no model to fall back to.
    expect(rig.backend.completions).toHaveLength(0)
    a.ws.close()
  })

  test('switching model between turns rebuilds the session while keeping its context', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a, specA)

    await promptOf(a, sessionId, specA)
    await promptOf(a, sessionId, specB)

    const [first, second] = rig.backend.completions
    expect(first.model).toBe(specA.modelId)
    expect(second.model).toBe(specB.modelId)
    // The rebuilt harness reopened the same session log, so the first turn is
    // still part of the model's context.
    expect(second.messages).toContain(fullSentence)

    a.ws.close()
  })

  test('switching model during a running turn is refused, and the turn is unaffected', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a, specA)

    const running = promptOf(a, sessionId, specA)
    await waitFor(() => textOf(a.updates).length > 0)
    await expect(promptOf(a, sessionId, specB)).rejects.toThrow(/while a turn is running/)

    expect((await running).stopReason).toBe('end_turn')
    expect(rig.backend.completions.map((call) => call.model)).toEqual([specA.modelId])

    a.ws.close()
  })

  test('a model id the gateway does not know fails the turn instead of falling back', async () => {
    rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const unknown: RunSpec = { modelId: 'no-such-model', thinkingLevel: 'off' }
    const { sessionId } = await newSession(a, unknown)

    await expect(promptOf(a, sessionId, unknown)).rejects.toThrow()
    const end = await awaitTurnOf(a, sessionId)
    expect(end.turn?.errorMessage).toBeTruthy()
    expect(rig.backend.completions.map((call) => call.model)).toEqual([unknown.modelId])

    a.ws.close()
  })
})

describe('revocation', () => {
  test('a bearer that stops introspecting loses its socket', async () => {
    const rig = await startRig({ revalidateIntervalMs: 50 })
    const a = await connectReady(rig.port, tokenA)
    await newSession(a)

    rig.backend.tokens.delete(tokenA)
    expect((await a.closed).code).toBe(wsCloseUnauthorized)
    await stopRig(rig)
  })
})

describe('per-user caps', () => {
  test('session/new is refused past the live-session cap', async () => {
    const rig = await startRig({ maxSessionsPerUser: 2 })
    const a = await connectReady(rig.port, tokenA)
    await newSession(a)
    await newSession(a)
    await expect(newSession(a)).rejects.toThrow(/session limit/)

    // The cap is per user, not global.
    const b = await connectReady(rig.port, tokenB)
    expect((await newSession(b)).sessionId).toBeTruthy()

    a.ws.close()
    b.ws.close()
    await stopRig(rig)
  })

  test('session/prompt is refused past the concurrent-turn cap', async () => {
    const rig = await startRig({ maxConcurrentTurnsPerUser: 1 })
    const a = await connectReady(rig.port, tokenA)
    const first = await newSession(a)
    const second = await newSession(a)

    const running = promptOf(a, first.sessionId)
    running.catch(() => {})
    await waitFor(() => textOf(a.updates).length > 0)
    await expect(promptOf(a, second.sessionId)).rejects.toThrow(/turn limit/)

    // The slot frees up once the running turn ends.
    await running
    expect((await promptOf(a, second.sessionId)).stopReason).toBe('end_turn')

    a.ws.close()
    await stopRig(rig)
  })
})

describe('erasure', () => {
  test('deleteSession hard-deletes the session and rejects a foreign caller', async () => {
    const rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const { sessionId } = await newSession(a)
    await promptOf(a, sessionId)
    expect(await sessionOnDisk(rig.dataDir, 'user-a', sessionId)).toBe(true)

    const b = await connectReady(rig.port, tokenB)
    await expect(b.conn.extMethod(runnerDeleteSessionMethod, { sessionId })).rejects.toThrow()
    expect(await sessionOnDisk(rig.dataDir, 'user-a', sessionId)).toBe(true)

    expect(await a.conn.extMethod(runnerDeleteSessionMethod, { sessionId })).toEqual({})
    expect(await sessionOnDisk(rig.dataDir, 'user-a', sessionId)).toBe(false)
    // Gone for good: the session no longer resolves for its owner either.
    await expect(a.conn.extMethod(runnerReplayMethod, { sessionId })).rejects.toThrow()

    a.ws.close()
    b.ws.close()
    await stopRig(rig)
  })

  test('POST /purge erases every trace of the caller', async () => {
    const rig = await startRig()
    const a = await connectReady(rig.port, tokenA)
    const mine = await newSession(a)
    await promptOf(a, mine.sessionId)
    const b = await connectReady(rig.port, tokenB)
    const theirs = await newSession(b)

    const unauthorized = await fetch(`http://localhost:${rig.port}/purge`, {
      method: 'POST',
      headers: { authorization: 'Bearer bogus-token' },
    })
    expect(unauthorized.status).toBe(401)
    expect(await sessionOnDisk(rig.dataDir, 'user-a', mine.sessionId)).toBe(true)

    const purged = await fetch(`http://localhost:${rig.port}/purge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(purged.status).toBe(204)
    expect(await exists(join(rig.dataDir, 'workspaces', 'user-a'))).toBe(false)
    expect(await sessionOnDisk(rig.dataDir, 'user-b', theirs.sessionId)).toBe(true)

    // Idempotent by contract: the backend retries purge, so a repeat call for
    // a user with nothing left must still succeed.
    const repeat = await fetch(`http://localhost:${rig.port}/purge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(repeat.status).toBe(204)

    a.ws.close()
    b.ws.close()
    await stopRig(rig)
  })
})
