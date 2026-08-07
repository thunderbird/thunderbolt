/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { RunSpec } from '../../shared/acp-types.ts'
import type { SessionStore } from '../../cli/src/acp/session-store.ts'
import {
  createSessionRegistry,
  createSessionRuntime,
  harnessConfigFor,
  type HarnessBundle,
  type OpenHarness,
  type RuntimeDeps,
  type RuntimeHarness,
} from './session-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { SessionStorage } from './storage.ts'

const runSpec: RunSpec = { modelId: 'model-a', thinkingLevel: 'medium' }

/** Scriptable fake harness: the test emits harness events and settles prompts. */
const createFakeHarness = () => {
  const listeners = new Set<(event: AgentHarnessEvent) => void>()
  let settlePrompt: ((message: AssistantMessage) => void) | null = null

  const harness: RuntimeHarness = {
    subscribe: (listener: (event: AgentHarnessEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: (_text: string) =>
      new Promise<AssistantMessage>((resolve) => {
        settlePrompt = resolve
      }),
    waitForIdle: () => Promise.resolve(),
    abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
  }

  return {
    harness,
    listenerCount: () => listeners.size,
    emitDelta: (delta: string) => {
      for (const listener of listeners) {
        listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } } as AgentHarnessEvent)
      }
    },
    finishTurn: (stopReason: AssistantMessage['stopReason'] = 'stop', errorMessage?: string) => {
      settlePrompt?.({ stopReason, errorMessage } as AssistantMessage)
      settlePrompt = null
    },
  }
}

type FakeHarness = ReturnType<typeof createFakeHarness>

/** An {@link OpenHarness} minting a fresh fake per run spec, recording each open. */
const createFakeOpener = () => {
  const opened: RunSpec[] = []
  const disposed: RunSpec[] = []
  const harnesses: FakeHarness[] = []

  const openHarness: OpenHarness = async (spec) => {
    opened.push(spec)
    const fake = createFakeHarness()
    harnesses.push(fake)
    const bundle: HarnessBundle = {
      harness: fake.harness,
      dispose: async () => {
        disposed.push(spec)
      },
    }
    return bundle
  }

  return { openHarness, opened, disposed, current: () => harnesses[harnesses.length - 1] }
}

const makeRuntime = async (journalLimit?: number, journalByteLimit?: number) => {
  const opener = createFakeOpener()
  const runtime = await createSessionRuntime({
    sessionId: crypto.randomUUID(),
    userId: 'user-a',
    bearer: 'bearer-1',
    runSpec,
    openHarness: opener.openHarness,
    journalLimit,
    journalByteLimit,
  })
  return {
    runtime,
    opener,
    emitDelta: (delta: string) => opener.current().emitDelta(delta),
    finishTurn: (stopReason?: AssistantMessage['stopReason'], errorMessage?: string) =>
      opener.current().finishTurn(stopReason, errorMessage),
  }
}

const textOf = (updates: SessionUpdate[]): string =>
  updates
    .map((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? u.content.text : ''))
    .join('')

/** Yield to pending microtasks so async prompt bookkeeping settles. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('SessionRuntime detached turns', () => {
  test('turn keeps streaming into the journal after detach; latest-turn replay catches a new sink up', async () => {
    const { runtime, emitDelta, finishTurn } = await makeRuntime()

    const seenByA: SessionUpdate[] = []
    const sinkA = (u: SessionUpdate) => seenByA.push(u)
    runtime.attach(sinkA, { replay: 'none' })

    const turn = runtime.prompt('do the thing')
    emitDelta('Hello ')

    // Detaching a sink that was never attached is a no-op.
    runtime.detach((u) => seenByA.push(u))
    emitDelta('wor')
    expect(textOf(seenByA)).toBe('Hello wor')

    // Simulate the tab closing: detach for real, the turn keeps going.
    runtime.detach(sinkA)
    expect(runtime.turnActive()).toBe(true)
    emitDelta('ld')
    finishTurn('stop')
    await turn

    expect(runtime.turnActive()).toBe(false)
    expect(textOf(seenByA)).toBe('Hello wor')

    // A fresh connection replays the whole turn.
    const seenByB: SessionUpdate[] = []
    const result = runtime.attach((u) => seenByB.push(u), { replay: 'latest-turn' })
    expect(textOf(seenByB)).toBe('Hello world')
    expect(result.turnActive).toBe(false)
    expect(result.turn?.stopReason).toBe('end_turn')
    expect(result.turn?.startSeq).toBe(1)
    expect(result.turn?.endSeq).toBe(3)
  })

  test('latest-turn replay mid-turn delivers the prefix and then goes live', async () => {
    const { runtime, emitDelta, finishTurn } = await makeRuntime()
    const turn = runtime.prompt('go')
    emitDelta('a')
    emitDelta('b')

    const seen: SessionUpdate[] = []
    const result = runtime.attach((u) => seen.push(u), { replay: 'latest-turn' })
    expect(textOf(seen)).toBe('ab')
    expect(result.turnActive).toBe(true)

    emitDelta('c')
    finishTurn()
    await turn
    expect(textOf(seen)).toBe('abc')
  })

  test('a replay whose turn start was evicted delivers only the retained suffix', async () => {
    const { runtime, emitDelta, finishTurn } = await makeRuntime(2)
    const turn = runtime.prompt('go')
    emitDelta('a')
    emitDelta('b')
    emitDelta('c') // journalLimit 2 → 'a' (seq 1) evicted
    finishTurn()
    await turn

    const seen: SessionUpdate[] = []
    runtime.attach((u) => seen.push(u), { replay: 'latest-turn' })
    expect(textOf(seen)).toBe('bc')
  })

  test('oversized updates are evicted by the byte cap, not just the entry cap', async () => {
    // Each delta entry serializes to well over 60 bytes, so a 200-byte budget
    // holds only the newest couple of entries regardless of the entry cap.
    const { runtime, emitDelta, finishTurn } = await makeRuntime(undefined, 200)
    const turn = runtime.prompt('go')
    emitDelta('aaaaaaaaaa')
    emitDelta('bbbbbbbbbb')
    emitDelta('cccccccccc')
    emitDelta('dddddddddd')
    finishTurn()
    await turn

    const seen: SessionUpdate[] = []
    runtime.attach((u) => seen.push(u), { replay: 'latest-turn' })
    // The head was evicted; whatever remains is a contiguous suffix ending in 'd's.
    expect(textOf(seen).endsWith('dddddddddd')).toBe(true)
    expect(textOf(seen).includes('aaaaaaaaaa')).toBe(false)
  })

  test('a second prompt while a turn runs is rejected', async () => {
    const { runtime, finishTurn } = await makeRuntime()
    const turn = runtime.prompt('one')
    await expect(runtime.prompt('two')).rejects.toThrow(/already running/)
    finishTurn()
    await turn
  })

  test('model failure rejects the prompt and records errorMessage for detached observers', async () => {
    const { runtime, finishTurn } = await makeRuntime()
    const turn = runtime.prompt('boom')
    turn.catch(() => {}) // the connection died; nobody awaits
    finishTurn('error', 'model exploded')
    await tick()

    const end = await runtime.awaitTurnEnd()
    expect(end?.errorMessage).toBe('model exploded')
    expect(end?.stopReason).toBeNull()
    expect(runtime.turnActive()).toBe(false)
  })

  test('a running turn keeps the bearer it started with; a later one takes effect next turn', async () => {
    const { runtime, finishTurn } = await makeRuntime()
    expect(runtime.modelBearer()).toBe('bearer-1')

    const first = runtime.prompt('go')
    runtime.setBearer('bearer-2')
    expect(runtime.modelBearer()).toBe('bearer-1')
    finishTurn()
    await first

    expect(runtime.modelBearer()).toBe('bearer-2')
    const second = runtime.prompt('again')
    expect(runtime.modelBearer()).toBe('bearer-2')
    finishTurn()
    await second
  })

  test('awaitTurnEnd blocks until the running turn ends', async () => {
    const { runtime, emitDelta, finishTurn } = await makeRuntime()
    const turn = runtime.prompt('go')
    emitDelta('x')

    let ended = false
    const waiting = runtime.awaitTurnEnd().then((end) => {
      ended = true
      return end
    })
    await tick()
    expect(ended).toBe(false)

    finishTurn()
    await turn
    const end = await waiting
    expect(ended).toBe(true)
    expect(end?.stopReason).toBe('end_turn')
  })
})

describe('SessionRuntime observers', () => {
  test('every attached observer receives the same live updates', async () => {
    const { runtime, emitDelta, finishTurn } = await makeRuntime()
    const first: SessionUpdate[] = []
    const second: SessionUpdate[] = []
    const sinkFirst = (u: SessionUpdate) => first.push(u)
    runtime.attach(sinkFirst, { replay: 'none' })
    runtime.attach((u) => second.push(u), { replay: 'none' })

    const turn = runtime.prompt('go')
    emitDelta('shared ')
    expect(textOf(first)).toBe('shared ')
    expect(textOf(second)).toBe('shared ')

    // One tab closes; the other keeps streaming.
    runtime.detach(sinkFirst)
    emitDelta('update')
    finishTurn()
    await turn

    expect(textOf(first)).toBe('shared ')
    expect(textOf(second)).toBe('shared update')
  })

  test('a session stays out of the sweeper until its last observer detaches', async () => {
    const { runtime } = await makeRuntime()
    const first = () => {}
    const second = () => {}
    runtime.attach(first, { replay: 'none' })
    runtime.attach(second, { replay: 'none' })

    const idle = () => runtime.isIdleSince(Date.now() + 1)
    expect(idle()).toBe(false)
    runtime.detach(first)
    expect(idle()).toBe(false)
    runtime.detach(() => {}) // an unknown sink cannot make a session idle
    expect(idle()).toBe(false)
    runtime.detach(second)
    expect(idle()).toBe(true)
  })
})

describe('SessionRuntime run spec', () => {
  test('opens under the requested spec and treats an unchanged one as a no-op', async () => {
    const { runtime, opener } = await makeRuntime()
    expect(runtime.runSpec()).toEqual(runSpec)
    expect(opener.opened).toEqual([runSpec])

    await runtime.reopen({ ...runSpec })
    expect(opener.opened).toHaveLength(1)
    expect(opener.disposed).toEqual([])
  })

  test('an idle spec change rebuilds the harness and keeps journal and observers', async () => {
    const { runtime, opener, emitDelta, finishTurn } = await makeRuntime()
    const seen: SessionUpdate[] = []
    runtime.attach((u) => seen.push(u), { replay: 'none' })

    const first = runtime.prompt('first')
    emitDelta('before ')
    finishTurn()
    await first
    const firstHarness = opener.current()

    const next: RunSpec = { modelId: 'model-b', thinkingLevel: 'off' }
    await runtime.reopen(next)
    expect(runtime.runSpec()).toEqual(next)
    expect(opener.opened).toEqual([runSpec, next])
    expect(opener.disposed).toEqual([runSpec])
    expect(firstHarness.listenerCount()).toBe(0)

    // The observer registered before the swap still sees the new harness's turn,
    // and the journal still holds the pre-switch turn for replay.
    const second = runtime.prompt('second')
    emitDelta('after')
    finishTurn()
    await second
    expect(textOf(seen)).toBe('before after')

    const replayed: SessionUpdate[] = []
    runtime.attach((u) => replayed.push(u), { replay: 'latest-turn' })
    expect(textOf(replayed)).toBe('after')
  })

  test('a spec change during a running turn is rejected instead of substituting a model', async () => {
    const { runtime, opener, finishTurn } = await makeRuntime()
    const turn = runtime.prompt('go')

    await expect(runtime.reopen({ modelId: 'model-b', thinkingLevel: 'off' })).rejects.toThrow(
      /cannot change the model .* while a turn is running/,
    )
    expect(runtime.runSpec()).toEqual(runSpec)
    expect(opener.opened).toEqual([runSpec])

    finishTurn()
    await turn
    // Once idle the same switch is allowed.
    await runtime.reopen({ modelId: 'model-b', thinkingLevel: 'off' })
    expect(runtime.runSpec().modelId).toBe('model-b')
  })

  test('a failed reopen leaves the session running on its current spec', async () => {
    const opener = createFakeOpener()
    let failNext = false
    const runtime = await createSessionRuntime({
      sessionId: crypto.randomUUID(),
      userId: 'user-a',
      bearer: 'bearer-1',
      runSpec,
      openHarness: async (spec, readBearer) => {
        if (failNext) throw new Error('gateway model unknown')
        return opener.openHarness(spec, readBearer)
      },
    })

    failNext = true
    await expect(runtime.reopen({ modelId: 'nope', thinkingLevel: 'off' })).rejects.toThrow(/gateway model unknown/)
    expect(runtime.runSpec()).toEqual(runSpec)
    expect(opener.disposed).toEqual([])

    failNext = false
    const turn = runtime.prompt('still works')
    opener.current().finishTurn()
    expect((await turn).stopReason).toBe('end_turn')
  })
})

describe('harnessConfigFor', () => {
  const deps: RuntimeDeps = {
    config: {
      port: 0,
      backendUrl: 'http://backend.test',
      dataDir: '/tmp/unused',
      idleSessionTtlMs: 1000,
      revalidateIntervalMs: 1000,
      maxSessionsPerUser: 2,
      maxConcurrentTurnsPerUser: 2,
      retentionMs: 1000,
    },
    store: {} as SessionStore,
    sessionId: 'session-1',
    userId: 'user-a',
    workspaceDir: '/tmp/unused/workspaces/user-a/session-1',
    skills: [{ name: 'a', description: 'd', instruction: 'i' }],
    existing: false,
  }

  test('carries the client’s model and thinking level onto the harness', () => {
    const config = harnessConfigFor(deps, { modelId: 'gateway-model-x', thinkingLevel: 'xhigh' }, 'bearer-1')
    expect(config.model).toBe('gateway-model-x')
    expect(config.thinking).toBe('xhigh')
  })

  test('routes through the backend gateway with the caller’s bearer and jails tools', () => {
    const config = harnessConfigFor(deps, runSpec, 'bearer-1')
    expect(config.provider).toBe('openai-compat')
    expect(config.baseUrl).toBe('http://backend.test/v1')
    expect(config.apiKey).toBe('bearer-1')
    expect(config.workspaceRoot).toBe(deps.workspaceDir)
    expect(config.cwd).toBe(deps.workspaceDir)
    expect(config.skills).toEqual(deps.skills)
  })
})

describe('SessionRegistry', () => {
  const config: RunnerConfig = {
    port: 0,
    backendUrl: 'http://backend.test',
    dataDir: '/tmp/unused',
    idleSessionTtlMs: 1000,
    revalidateIntervalMs: 1000,
    maxSessionsPerUser: 2,
    maxConcurrentTurnsPerUser: 2,
    retentionMs: 1000,
  }

  const makeRegistry = (overrides: Partial<RunnerConfig> = {}) => {
    const openers = new Map<string, ReturnType<typeof createFakeOpener>>()
    const disposed: string[] = []
    /** In-memory stand-in for the on-disk trees, as `<userId>/<sessionId>`. */
    const stored = new Set<string>()

    const storage: SessionStorage = {
      workspaceDir: (userId, sessionId) => `/tmp/unused/workspaces/${userId}/${sessionId}`,
      deleteSession: async (userId, sessionId) => stored.delete(`${userId}/${sessionId}`),
      deleteUser: async (userId) => {
        for (const entry of stored) {
          if (entry.startsWith(`${userId}/`)) stored.delete(entry)
        }
      },
      purgeExpired: async (_cutoffMs, isLive) => {
        const expired = [...stored].filter((entry) => !isLive(entry.slice(entry.indexOf('/') + 1)))
        for (const entry of expired) stored.delete(entry)
        return expired.length
      },
    }

    const openHarnessFor = ({ sessionId, userId }: RuntimeDeps): OpenHarness => {
      const opener = createFakeOpener()
      openers.set(sessionId, opener)
      stored.add(`${userId}/${sessionId}`)
      return async (spec, readBearer) => {
        const bundle = await opener.openHarness(spec, readBearer)
        return {
          harness: bundle.harness,
          dispose: async () => {
            disposed.push(sessionId)
          },
        }
      }
    }

    return {
      openers,
      disposed,
      stored,
      registry: createSessionRegistry({ ...config, ...overrides }, openHarnessFor, storage),
    }
  }

  const request = (userId: string) => ({ userId, bearer: `bearer-${userId}`, skills: [], runSpec })

  test('resume returns the live runtime and enforces ownership', async () => {
    const { registry } = makeRegistry()
    const runtime = await registry.create(request('user-a'))

    const resumed = await registry.resume({ ...request('user-a'), sessionId: runtime.sessionId })
    expect(resumed).toBe(runtime)

    await expect(registry.resume({ ...request('user-b'), sessionId: runtime.sessionId })).rejects.toThrow(
      /unknown session/,
    )
    expect(() => registry.require('user-b', runtime.sessionId)).toThrow(/unknown session/)
    expect(registry.require('user-a', runtime.sessionId)).toBe(runtime)
  })

  test('resume rejects malformed session ids before they reach disk paths', async () => {
    const { registry } = makeRegistry()
    await expect(registry.resume({ ...request('user-a'), sessionId: '../escape' })).rejects.toThrow(
      /invalid session id/,
    )
  })

  test('resume applies a new run spec while idle but never mid-turn', async () => {
    const { registry, openers } = makeRegistry()
    const runtime = await registry.create(request('user-a'))
    const next: RunSpec = { modelId: 'model-b', thinkingLevel: 'low' }

    await registry.resume({ ...request('user-a'), sessionId: runtime.sessionId, runSpec: next })
    expect(runtime.runSpec()).toEqual(next)

    const turn = runtime.prompt('go')
    const during: RunSpec = { modelId: 'model-c', thinkingLevel: 'high' }
    await registry.resume({ ...request('user-a'), sessionId: runtime.sessionId, runSpec: during })
    // The running turn keeps its model; the client's next prompt applies its own.
    expect(runtime.runSpec()).toEqual(next)

    openers.get(runtime.sessionId)?.current().finishTurn()
    await turn
  })

  test('requireForTurn rebuilds for a new spec while idle and refuses one mid-turn', async () => {
    const { registry, openers } = makeRegistry()
    const runtime = await registry.create(request('user-a'))
    const next: RunSpec = { modelId: 'model-b', thinkingLevel: 'low' }

    expect(await registry.requireForTurn({ ...request('user-a'), sessionId: runtime.sessionId, runSpec: next })).toBe(
      runtime,
    )
    expect(openers.get(runtime.sessionId)?.opened).toEqual([runSpec, next])

    const turn = runtime.prompt('go')
    await expect(
      registry.requireForTurn({
        ...request('user-a'),
        sessionId: runtime.sessionId,
        runSpec: { modelId: 'model-c', thinkingLevel: 'off' },
      }),
    ).rejects.toThrow(/while a turn is running/)

    openers.get(runtime.sessionId)?.current().finishTurn()
    await turn
  })

  test('requireForTurn refuses another user’s session', async () => {
    const { registry } = makeRegistry()
    const runtime = await registry.create(request('user-a'))
    await expect(
      registry.requireForTurn({ ...request('user-b'), sessionId: runtime.sessionId }),
    ).rejects.toThrow(/unknown session/)
  })

  test('sweep disposes only idle detached runtimes', async () => {
    const { registry } = makeRegistry()
    const idle = await registry.create(request('user-a'))
    const attached = await registry.create(request('user-a'))
    attached.attach(() => {}, { replay: 'none' })

    // Both were just touched; nothing is past a 0ms TTL cutoff except idle ones
    // after the clock advances. Force staleness with a negative TTL window.
    const swept = await registry.sweep(-1)
    expect(swept).toBe(1)
    expect(() => registry.require('user-a', idle.sessionId)).toThrow(/unknown session/)
    expect(registry.require('user-a', attached.sessionId)).toBe(attached)
  })

  test('the per-user session cap is enforced and scoped to that user', async () => {
    const { registry } = makeRegistry()
    await registry.create(request('user-a'))
    await registry.create(request('user-a'))

    await expect(registry.create(request('user-a'))).rejects.toThrow(/session limit reached/)
    expect(await registry.create(request('user-b'))).toBeDefined()
  })

  test('the per-user concurrent turn cap counts only that user’s running turns', async () => {
    const { registry, openers } = makeRegistry({ maxConcurrentTurnsPerUser: 1 })
    const runtime = await registry.create(request('user-a'))
    registry.requireTurnSlot('user-a')

    const turn = runtime.prompt('go')
    expect(() => registry.requireTurnSlot('user-a')).toThrow(/turn limit reached/)
    expect(() => registry.requireTurnSlot('user-b')).not.toThrow()

    openers.get(runtime.sessionId)?.current().finishTurn()
    await turn
    expect(() => registry.requireTurnSlot('user-a')).not.toThrow()
  })

  test('delete disposes the live runtime and erases its disk state', async () => {
    const { registry, disposed, stored } = makeRegistry()
    const runtime = await registry.create(request('user-a'))

    await registry.delete('user-a', runtime.sessionId)
    expect(disposed).toEqual([runtime.sessionId])
    expect(stored.size).toBe(0)
    expect(() => registry.require('user-a', runtime.sessionId)).toThrow(/unknown session/)
  })

  test('delete refuses another user’s session and an unknown one alike', async () => {
    const { registry, disposed } = makeRegistry()
    const runtime = await registry.create(request('user-a'))

    await expect(registry.delete('user-b', runtime.sessionId)).rejects.toThrow(/unknown session/)
    await expect(registry.delete('user-a', crypto.randomUUID())).rejects.toThrow(/unknown session/)
    expect(disposed).toEqual([])
    expect(registry.require('user-a', runtime.sessionId)).toBe(runtime)
  })

  test('purgeUser disposes every runtime the user owns and leaves others alone', async () => {
    const { registry, stored } = makeRegistry()
    const mine = await registry.create(request('user-a'))
    const theirs = await registry.create(request('user-b'))

    await registry.purgeUser('user-a')
    expect(() => registry.require('user-a', mine.sessionId)).toThrow(/unknown session/)
    expect(registry.require('user-b', theirs.sessionId)).toBe(theirs)
    expect([...stored]).toEqual([`user-b/${theirs.sessionId}`])
  })

  test('purgeExpired never erases a session that still has a live runtime', async () => {
    const { registry, stored } = makeRegistry()
    const live = await registry.create(request('user-a'))

    expect(await registry.purgeExpired(1000)).toBe(0)
    expect([...stored]).toEqual([`user-a/${live.sessionId}`])
  })
})
