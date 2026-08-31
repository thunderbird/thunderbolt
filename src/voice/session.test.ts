/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Earcons } from '@/voice/audio/earcon'
import type { PlaybackQueue } from '@/voice/audio/playback'
import type { VadGate, VadHandlers } from '@/voice/audio/vad'
import type { AudioChunk, PcmFrame, Transcript, VoiceEngine } from '@/voice/engine/types'
import type { ReplyFn, SessionState } from '@/voice/session'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// The session creates its VAD gate and playback queue internally; mock both so a
// test can drive utterances through the loop without a mic or AudioContext. The
// captured `onUtterance` is the handle used to simulate the user speaking.
let vadGateCalls = 0
let gateStartCalls = 0
let gateDestroyCalls = 0
let vadHandlers: VadHandlers | null = null
/** Set by a test to hold `gate.start()` open, standing in for a pending permission prompt. */
let pendingGateStart: Promise<void> | null = null
/** Every `setListening` value the session pushed, in order. */
let listeningLog: boolean[] = []

const resetVad = () => {
  vadGateCalls = 0
  gateStartCalls = 0
  gateDestroyCalls = 0
  vadHandlers = null
  pendingGateStart = null
  listeningLog = []
}

mock.module('@/voice/audio/vad', () => ({
  createVadGate: (handlers: VadHandlers): VadGate => {
    vadGateCalls++
    vadHandlers = handlers
    return {
      start: async () => {
        gateStartCalls++
        await pendingGateStart
      },
      pause: async () => {},
      destroy: async () => {
        gateDestroyCalls++
      },
      setListening: (value: boolean) => {
        listeningLog.push(value)
      },
    }
  },
}))

let enqueued: AudioChunk[] = []
mock.module('@/voice/audio/playback', () => ({
  createPlaybackQueue: (): PlaybackQueue =>
    ({
      enqueue: (chunk: AudioChunk) => enqueued.push(chunk),
      flush: () => {},
      close: () => {},
      getLevel: () => 0,
      // Always drained so the session's "wait for playback" loop exits at once
      // (the real loop polls a timer we don't want to run in tests).
      get isPlaying() {
        return false
      },
    }) as unknown as PlaybackQueue,
}))

const { createVoiceSession } = await import('@/voice/session')

/** Engine that transcribes to a fixed string and synthesizes one chunk per text chunk. */
const makeEngine = (transcript: string, overrides: Partial<VoiceEngine> = {}): VoiceEngine => ({
  id: 'fake',
  load: async () => {},
  transcribe: async function* (_audio: AsyncIterable<PcmFrame>): AsyncIterable<Transcript> {
    yield { text: transcript, isFinal: true }
  },
  synthesize: async function* (text: AsyncIterable<string>): AsyncIterable<AudioChunk> {
    for await (const _chunk of text) {
      yield { pcm: new Float32Array(1), sampleRate: 16000 }
    }
  },
  dispose: () => {},
  ...overrides,
})

/**
 * Records which cues played. Injected everywhere rather than defaulted, because
 * the real ones need an AudioContext the mocked playback queue doesn't have —
 * and because when a cue fires is behaviour worth asserting, not a side effect.
 */
const makeEarcons = () => {
  const played: string[] = []
  const earcons: Earcons = {
    listening: () => played.push('listening'),
    captured: () => played.push('captured'),
  }
  return { earcons, played }
}

/**
 * Lets every already-scheduled promise continuation run. The global preload installs
 * @sinonjs fake timers, so a `setTimeout(0)` round trip would never fire.
 */
const drainMicrotasks = async () => {
  for (const _ of Array.from({ length: 20 })) {
    await Promise.resolve()
  }
}

const makeReply = (tokens: string[]): ReplyFn =>
  async function* (_userText, signal) {
    for (const token of tokens) {
      if (signal.aborted) {
        return
      }
      yield token
    }
  }

describe('createVoiceSession', () => {
  beforeEach(() => {
    resetVad()
    enqueued = []
  })

  test('runs a full turn: listen → think → speak → listen and reports both transcripts', async () => {
    const states: SessionState[] = []
    const transcripts: Array<[string, string]> = []
    const session = createVoiceSession({
      earcons: makeEarcons().earcons,
      engine: makeEngine('hello world'),
      reply: makeReply(['Hi', ' there.']),
      onState: (s) => states.push(s),
      onTranscript: (text, role) => transcripts.push([role, text]),
    })

    await session.start()
    expect(vadHandlers).not.toBeNull()
    await vadHandlers!.onUtterance(new Float32Array(16000))

    expect(states).toEqual(['listening', 'thinking', 'speaking', 'listening'])
    expect(transcripts).toContainEqual(['user', 'hello world'])
    expect(transcripts).toContainEqual(['assistant', 'Hi there.'])
    expect(enqueued.length).toBeGreaterThan(0)
  })

  test('drops a Whisper silence-hallucination without replying', async () => {
    const states: SessionState[] = []
    const transcripts: Array<[string, string]> = []
    const session = createVoiceSession({
      earcons: makeEarcons().earcons,
      engine: makeEngine('thanks for watching'),
      reply: makeReply(['should not run']),
      onState: (s) => states.push(s),
      onTranscript: (text, role) => transcripts.push([role, text]),
    })

    await session.start()
    await vadHandlers!.onUtterance(new Float32Array(16000))

    expect(states).toEqual(['listening', 'thinking', 'listening'])
    expect(transcripts).toEqual([])
    expect(enqueued).toEqual([])
  })

  test('a newer utterance supersedes an in-flight turn (abort)', async () => {
    const transcripts: Array<[string, string]> = []
    // First transcription hangs until its turn is aborted; the second resolves
    // normally. So when the second utterance arrives and calls turn.abort(), the
    // first turn unwinds without producing a transcript and only the second speaks.
    let transcribeCalls = 0
    const engine: VoiceEngine = {
      ...makeEngine('unused'),
      transcribe: async function* (_audio, signal) {
        transcribeCalls++
        if (transcribeCalls === 1) {
          await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
          return
        }
        yield { text: 'second turn', isFinal: true }
      },
    }
    const session = createVoiceSession({
      earcons: makeEarcons().earcons,
      engine,
      reply: makeReply(['done.']),
      onTranscript: (text, role) => transcripts.push([role, text]),
    })

    await session.start()
    const first = vadHandlers!.onUtterance(new Float32Array(16000))
    const second = vadHandlers!.onUtterance(new Float32Array(16000))
    await Promise.all([first, second])

    // The superseded turn produced nothing; only the second turn's transcripts land.
    expect(transcripts).toEqual([
      ['user', 'second turn'],
      ['assistant', 'done.'],
    ])
  })

  test('stop() during startup does not open an orphaned mic (stopped guard)', async () => {
    // Hold engine.load() open to land stop() squarely in the startup window,
    // before start() has assigned the VAD gate.
    let resolveLoad: () => void = () => {}
    const engine = makeEngine('hi', { load: () => new Promise<void>((resolve) => (resolveLoad = resolve)) })
    const session = createVoiceSession({ earcons: makeEarcons().earcons, engine, reply: makeReply(['hi']) })

    const startPromise = session.start()
    await session.stop()
    resolveLoad()
    await startPromise

    // The mic now opens alongside engine.load() rather than after it, so a stop()
    // in this window lands on a gate that is already live. What matters is
    // unchanged and is the whole point of the guard: nothing is left holding the
    // mic. start() resumes, sees `stopped`, and tears down the gate it never
    // published — `stop()` itself couldn't, since `vadGate` was still null.
    expect(vadGateCalls).toBe(1)
    expect(gateStartCalls).toBe(1)
    expect(gateDestroyCalls).toBe(1)
    expect(session.state).toBe('idle')
  })

  test('stop() after the gate is running tears it down', async () => {
    const session = createVoiceSession({
      earcons: makeEarcons().earcons,
      engine: makeEngine('hi'),
      reply: makeReply(['hi']),
    })
    await session.start()
    expect(gateStartCalls).toBe(1)
    await session.stop()
    expect(gateDestroyCalls).toBe(1)
    expect(session.state).toBe('idle')
  })

  test('barge-in: onSpeechStart while speaking aborts the turn and returns to listening', async () => {
    const transcripts: Array<[string, string]> = []
    const session = createVoiceSession({
      earcons: makeEarcons().earcons,
      engine: makeEngine('user turn'),
      reply: makeReply(['Hello, ', 'this is a long-winded reply.']),
      onTranscript: (text, role) => transcripts.push([role, text]),
    })

    await session.start()
    const turn = vadHandlers!.onUtterance(new Float32Array(16000))
    // Advance to 'speaking' with the turn still in flight (the playback-drain loop
    // uses a real timer, so a microtask flush can't run the turn to completion).
    for (let i = 0; i < 50 && session.state !== 'speaking'; i++) {
      await Promise.resolve()
    }
    expect(session.state).toBe('speaking')

    vadHandlers!.onSpeechStart!() // the user starts talking over the assistant
    await turn

    // Cut off: back to listening, and the assistant reply never committed — a
    // turn that ran to completion would have pushed an ['assistant', …] transcript.
    expect(session.state).toBe('listening')
    expect(transcripts.some(([role]) => role === 'assistant')).toBe(false)
    expect(transcripts).toContainEqual(['user', 'user turn'])
  })

  test('onSpeechStart is a no-op when not thinking or speaking', async () => {
    const session = createVoiceSession({
      earcons: makeEarcons().earcons,
      engine: makeEngine('hi'),
      reply: makeReply(['hi']),
    })
    await session.start()
    expect(session.state).toBe('listening')
    vadHandlers!.onSpeechStart!() // nothing to interrupt
    expect(session.state).toBe('listening')
  })

  describe('earcons (THU-856)', () => {
    test('announces the mic opening, which is the moment nothing on screen marks', async () => {
      const { earcons, played } = makeEarcons()
      const session = createVoiceSession({ earcons, engine: makeEngine('hi'), reply: makeReply(['ok']) })

      await session.start()

      expect(played).toEqual(['listening'])
    })

    test('does not announce again when a finished turn hands the mic back', async () => {
      const { earcons, played } = makeEarcons()
      const session = createVoiceSession({ earcons, engine: makeEngine('hi'), reply: makeReply(['ok']) })

      await session.start()
      await vadHandlers!.onUtterance(new Float32Array(16000))

      // The assistant's own voice stopping is already the cue; repeating the
      // invitation every turn would be noise.
      expect(played.filter((cue) => cue === 'listening')).toHaveLength(1)
    })

    test('acknowledges each committed utterance', async () => {
      const { earcons, played } = makeEarcons()
      const session = createVoiceSession({ earcons, engine: makeEngine('hi'), reply: makeReply(['ok']) })

      await session.start()
      await vadHandlers!.onUtterance(new Float32Array(16000))
      await vadHandlers!.onUtterance(new Float32Array(16000))

      expect(played.filter((cue) => cue === 'captured')).toHaveLength(2)
    })

    test('acknowledges before transcription, not after it', async () => {
      const { earcons, played } = makeEarcons()
      const engine = makeEngine('hi', {
        transcribe: async function* () {
          // Whatever the cue order is, it is already decided by the time the
          // engine is reached — a cue that waits on this arrives too late.
          expect(played).toContain('captured')
          yield { text: 'hi', isFinal: true }
        },
      })
      const session = createVoiceSession({ earcons, engine, reply: makeReply(['ok']) })

      await session.start()
      await vadHandlers!.onUtterance(new Float32Array(16000))

      expect(played).toContain('captured')
    })

    test('barge-in does not re-invite the user who is already talking', async () => {
      const { earcons, played } = makeEarcons()
      const session = createVoiceSession({
        earcons,
        engine: makeEngine('user turn'),
        reply: makeReply(['a long-winded reply.']),
      })

      await session.start()
      const turn = vadHandlers!.onUtterance(new Float32Array(16000))
      await Promise.resolve()
      vadHandlers!.onSpeechStart?.()
      await turn

      expect(played.filter((cue) => cue === 'listening')).toHaveLength(1)
    })
  })

  describe('startup', () => {
    test('opens the mic without waiting for the engine to load', async () => {
      const order: string[] = []
      let releaseLoad = () => {}
      const engine = makeEngine('hi', {
        load: async () => {
          order.push('load:start')
          await new Promise<void>((resolve) => {
            releaseLoad = resolve
          })
          order.push('load:end')
        },
      })
      const session = createVoiceSession({ earcons: makeEarcons().earcons, engine, reply: makeReply(['ok']) })

      const starting = session.start()
      await Promise.resolve()

      // The mic is requested while the engine is still loading; serialised, the
      // user would wait for the sum of a network round trip and a permission
      // prompt instead of the slower of the two.
      expect(gateStartCalls).toBe(1)
      expect(order).toEqual(['load:start'])

      releaseLoad()
      await starting
    })

    test('keeps the mic muted until the engine has finished loading', async () => {
      let finishLoad = () => {}
      const engine = makeEngine('hi', {
        load: () =>
          new Promise<void>((resolve) => {
            finishLoad = resolve
          }),
      })
      const session = createVoiceSession({ earcons: makeEarcons().earcons, engine, reply: makeReply(['ok']) })

      const starting = session.start()
      await drainMicrotasks()

      // The mic is open but attestation is still in flight. Frames must not reach
      // the endpointer yet: an utterance committed here would hit an engine that
      // can't transcribe, and start()'s tail would then stomp that in-flight turn.
      expect(gateStartCalls).toBe(1)
      expect(listeningLog).toEqual([false])

      finishLoad()
      await starting

      expect(listeningLog).toEqual([false, true])
    })

    test('releases the mic when the engine fails after it opened', async () => {
      const engine = makeEngine('hi', {
        load: async () => {
          throw new Error('attestation failed')
        },
      })
      const session = createVoiceSession({ earcons: makeEarcons().earcons, engine, reply: makeReply(['ok']) })

      // Racing the two means a live mic can outlive a failed start, and nothing
      // else holds a reference to it — the caller's stop() sees vadGate as null.
      await expect(session.start()).rejects.toThrow('attestation failed')

      expect(gateDestroyCalls).toBe(1)
    })

    test('releases the mic when the engine fails while the permission prompt is still open', async () => {
      let allowMic = () => {}
      pendingGateStart = new Promise<void>((resolve) => {
        allowMic = resolve
      })
      const engine = makeEngine('hi', {
        load: async () => {
          throw new Error('attestation failed')
        },
      })
      const session = createVoiceSession({ earcons: makeEarcons().earcons, engine, reply: makeReply(['ok']) })

      // Attestation fails fast while the user is still deciding whether to click
      // Allow. Tearing down now would destroy a gate that hasn't acquired the mic
      // yet, and the stream getUserMedia hands over afterwards would be orphaned.
      const starting = session.start()
      await drainMicrotasks()
      expect(gateDestroyCalls).toBe(0)

      allowMic()
      await expect(starting).rejects.toThrow('attestation failed')

      expect(gateDestroyCalls).toBe(1)
    })

    test('does not announce readiness when startup fails', async () => {
      const { earcons, played } = makeEarcons()
      const engine = makeEngine('hi', {
        load: async () => {
          throw new Error('attestation failed')
        },
      })
      const session = createVoiceSession({ earcons, engine, reply: makeReply(['ok']) })

      await session.start().catch(() => {})

      expect(played).toEqual([])
    })
  })
})
