/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  BeginDebugTranscriptTurnInput,
  DebugTranscriptCaptureStatus,
  DebugTranscriptEngine,
  DebugTranscriptFailureV1,
  DebugTranscriptTimestampV1,
  DebugTranscriptTurnNotes,
  DebugTranscriptTurnOutcome,
} from './types'

const maxTurnsPerThread = 50
const maxThreads = 10

const notesByThread = new Map<string, DebugTranscriptTurnNotes[]>()
const startedMonotonicByTurn = new WeakMap<DebugTranscriptTurnNotes, number>()
let captureEnabled = false
let recorderDisabled = false
let warned = false

const protectRecorder = (operation: () => void): void => {
  if (!captureEnabled || recorderDisabled) {
    return
  }
  try {
    operation()
  } catch (error) {
    recorderDisabled = true
    if (!warned) {
      warned = true
      console.warn('Debug transcript recorder disabled after an internal error', error)
    }
  }
}

const touchThread = (threadId: string, notes: DebugTranscriptTurnNotes[]): void => {
  notesByThread.delete(threadId)
  notesByThread.set(threadId, notes)
}

const findTurn = (threadId: string, traceId: string): DebugTranscriptTurnNotes | undefined => {
  const notes = notesByThread.get(threadId)
  if (notes) {
    touchThread(threadId, notes)
  }
  return notes?.findLast((turn) => turn.traceId === traceId)
}

const updateTurn = (threadId: string, traceId: string, update: (turn: DebugTranscriptTurnNotes) => void): void => {
  protectRecorder(() => {
    const turn = findTurn(threadId, traceId)
    if (turn) {
      update(turn)
    }
  })
}

const timestampFor = (turn: DebugTranscriptTurnNotes): DebugTranscriptTimestampV1 => ({
  wallClock: new Date().toISOString(),
  monotonicOffsetMs: Math.max(0, Math.round(performance.now() - startedMonotonicByTurn.get(turn)!)),
})

const currentAttempt = (turn: DebugTranscriptTurnNotes): number => Math.max(1, turn.failures.at(-1)?.attempt ?? 1)

const retryReasons = (turn: DebugTranscriptTurnNotes): string[] => [
  ...new Set(turn.failures.flatMap((failure) => failure.retryReasons)),
]

const failureFor = (
  turn: DebugTranscriptTurnNotes,
  overrides: Partial<DebugTranscriptFailureV1>,
  timestamp = timestampFor(turn),
): DebugTranscriptFailureV1 => ({
  errorClass: null,
  message: null,
  attempt: currentAttempt(turn),
  retryReasons: retryReasons(turn),
  aborted: false,
  timestamp,
  ...overrides,
})

/** Begin a turn, or refresh its correlation metadata at a retry boundary. */
export const beginDebugTranscriptTurn = (input: BeginDebugTranscriptTurnInput): void => {
  protectRecorder(() => {
    const existing = findTurn(input.threadId, input.traceId)
    if (existing) {
      Object.assign(existing, {
        engine: input.engine,
        model: { ...input.model },
        agentId: input.agentId,
        userMessageId: input.userMessageId ?? existing.userMessageId,
      })
      return
    }
    const turn: DebugTranscriptTurnNotes = {
      traceId: input.traceId,
      userMessageId: input.userMessageId ?? null,
      engine: input.engine,
      model: { ...input.model },
      agentId: input.agentId,
      startedAt: { wallClock: new Date().toISOString(), monotonicOffsetMs: 0 },
      endedAt: null,
      outcome: null,
      systemPrompts: [],
      failures: [],
    }
    startedMonotonicByTurn.set(turn, performance.now())
    const notes = notesByThread.get(input.threadId) ?? []
    notes.push(turn)
    if (notes.length > maxTurnsPerThread) {
      notes.shift()
    }
    touchThread(input.threadId, notes)
    if (notesByThread.size > maxThreads) {
      const oldest = notesByThread.keys().next()
      if (!oldest.done) {
        notesByThread.delete(oldest.value)
      }
    }
  })
}

/** Note system-prompt changes, tagged with the current attempt. */
export const recordDebugTranscriptSystemPrompts = (
  threadId: string,
  traceId: string,
  prompts: readonly string[],
): void => {
  updateTurn(threadId, traceId, (turn) => {
    for (const text of prompts) {
      if (turn.systemPrompts.at(-1)?.text !== text) {
        turn.systemPrompts.push({ text, attempt: currentAttempt(turn), timestamp: timestampFor(turn) })
      }
    }
  })
}

/** Note a model failure without changing chat error behavior. */
export const recordDebugTranscriptFailure = (
  threadId: string,
  traceId: string,
  error: { errorClass: string; message: string },
): void => {
  updateTurn(threadId, traceId, (turn) => {
    turn.failures.push(failureFor(turn, error))
  })
}

/** Attach an automatic retry reason and attempts made to the latest failure. */
export const recordDebugTranscriptRetry = (
  threadId: string,
  traceId: string,
  reason: string,
  attemptsMade: number,
): void => {
  updateTurn(threadId, traceId, (turn) => {
    const latest = turn.failures.at(-1)
    if (latest && !latest.aborted) {
      latest.attempt = Math.max(latest.attempt, attemptsMade)
      latest.retryReasons = [...new Set([...latest.retryReasons, reason])]
      return
    }
    turn.failures.push(failureFor(turn, { attempt: attemptsMade, retryReasons: [reason] }))
  })
}

/** Finish timing and outcome notes for one turn. */
export const finishDebugTranscriptTurn = (
  threadId: string,
  traceId: string,
  outcome: DebugTranscriptTurnOutcome,
  engine: DebugTranscriptEngine,
): void => {
  updateTurn(threadId, traceId, (turn) => {
    if (turn.endedAt) {
      return
    }
    const endedAt = timestampFor(turn)
    if (outcome === 'abort') {
      turn.failures.push(failureFor(turn, { aborted: true }, endedAt))
    }
    turn.engine = engine
    turn.outcome = outcome
    turn.endedAt = endedAt
  })
}

/** Return detached notes for one thread. */
export const getDebugTranscriptNotes = (threadId: string): DebugTranscriptTurnNotes[] =>
  structuredClone(notesByThread.get(threadId) ?? [])

/** Return whether the fail-closed recorder guard has latched. */
export const getDebugTranscriptCaptureStatus = (): DebugTranscriptCaptureStatus => ({ recorderDisabled })

/** Disable capture and discard notes that cannot be uploaded. */
export const setDebugTranscriptCaptureEnabled = (enabled: boolean): void => {
  captureEnabled = enabled
  if (!enabled) {
    notesByThread.clear()
  }
}

/** Clear all identity-scoped notes and reset an internal-error latch. */
export const clearDebugTranscriptRecorder = (): void => {
  notesByThread.clear()
  recorderDisabled = false
  warned = false
}
