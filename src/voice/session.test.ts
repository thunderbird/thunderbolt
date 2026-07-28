/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

const resetVad = () => {
  vadGateCalls = 0
  gateStartCalls = 0
  gateDestroyCalls = 0
  vadHandlers = null
}

mock.module('@/voice/audio/vad', () => ({
  createVadGate: (handlers: VadHandlers): VadGate => {
    vadGateCalls++
    vadHandlers = handlers
    return {
      start: async () => {
        gateStartCalls++
      },
      pause: async () => {},
      destroy: async () => {
        gateDestroyCalls++
      },
      setListening: () => {},
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
    // before start() has created/assigned the VAD gate.
    let resolveLoad: () => void = () => {}
    const engine = makeEngine('hi', { load: () => new Promise<void>((resolve) => (resolveLoad = resolve)) })
    const session = createVoiceSession({ engine, reply: makeReply(['hi']) })

    const startPromise = session.start()
    await session.stop()
    resolveLoad()
    await startPromise

    // With the guard, start() bails after load() resolves — the gate is never
    // even created, so no mic is opened and no gate is left running.
    expect(vadGateCalls).toBe(0)
    expect(gateStartCalls).toBe(0)
    expect(session.state).toBe('idle')
  })

  test('stop() after the gate is running tears it down', async () => {
    const session = createVoiceSession({ engine: makeEngine('hi'), reply: makeReply(['hi']) })
    await session.start()
    expect(gateStartCalls).toBe(1)
    await session.stop()
    expect(gateDestroyCalls).toBe(1)
    expect(session.state).toBe('idle')
  })
})
