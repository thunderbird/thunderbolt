/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  clearFinishedAnnouncement,
  getReplyPhase,
  isFinishedAnnouncement,
  maxAnnouncedReplyLength,
  nextReplyAnnouncement,
  type ReplyAnnouncementInput,
  type ReplyAnnouncementState,
  type ReplyPhase,
} from './reply-announcement'

const idle: ReplyAnnouncementState = { phase: 'idle', polite: null, assertive: null }

const input = (phase: ReplyPhase, overrides: Partial<ReplyAnnouncementInput> = {}): ReplyAnnouncementInput => ({
  phase,
  stopped: false,
  replyText: '',
  muted: false,
  ...overrides,
})

/** Feed a sequence of phases through the reducer, as the hook does across renders. */
const run = (start: ReplyAnnouncementState, steps: ReplyAnnouncementInput[]) =>
  steps.reduce((state, step) => nextReplyAnnouncement(state, step), start)

describe('getReplyPhase', () => {
  const settled = { retriesExhausted: false, stopped: false }

  it('is responding while the turn is active, even with an error held for a retry', () => {
    expect(getReplyPhase({ isActive: true, hasError: false }, settled)).toBe('responding')
    expect(getReplyPhase({ isActive: true, hasError: true }, settled)).toBe('responding')
  })

  it('is idle with nothing running and no error', () => {
    expect(getReplyPhase({ isActive: false, hasError: false }, settled)).toBe('idle')
  })

  it('is settling while an error waits for the retry decision', () => {
    expect(getReplyPhase({ isActive: false, hasError: true }, settled)).toBe('settling')
  })

  it('is failed once retries are exhausted', () => {
    expect(getReplyPhase({ isActive: false, hasError: true }, { retriesExhausted: true, stopped: false })).toBe(
      'failed',
    )
  })

  it('treats an error after Stop as a stopped turn, not a failure', () => {
    expect(getReplyPhase({ isActive: false, hasError: true }, { retriesExhausted: true, stopped: true })).toBe('idle')
  })
})

describe('nextReplyAnnouncement', () => {
  it('stays silent when the phase does not change', () => {
    const responding = run(idle, [input('responding')])
    expect(nextReplyAnnouncement(responding, input('responding'))).toBe(responding)
    expect(nextReplyAnnouncement(idle, input('idle', { replyText: 'Hi' }))).toBe(idle)
  })

  it('announces that a reply is coming when a turn starts', () => {
    expect(run(idle, [input('responding')])).toEqual({
      phase: 'responding',
      polite: { kind: 'responding' },
      assertive: null,
    })
  })

  it('reads a short finished reply in full', () => {
    const state = run(idle, [input('responding'), input('idle', { replyText: 'Paris is the capital of France.' })])
    expect(state.polite).toEqual({ kind: 'reply', text: 'Paris is the capital of France.' })
    expect(state.assertive).toBeNull()
  })

  it('reads a reply exactly at the length limit, and says "ready" one character past it', () => {
    const atLimit = 'a'.repeat(maxAnnouncedReplyLength)
    expect(run(idle, [input('responding'), input('idle', { replyText: atLimit })]).polite).toEqual({
      kind: 'reply',
      text: atLimit,
    })
    expect(run(idle, [input('responding'), input('idle', { replyText: `${atLimit}a` })]).polite).toEqual({
      kind: 'ready',
    })
  })

  it('says "ready" for a reply with no speakable text, such as a widget or tool result', () => {
    expect(run(idle, [input('responding'), input('idle')]).polite).toEqual({ kind: 'ready' })
  })

  it('announces a stopped reply instead of reading what streamed before Stop', () => {
    const state = run(idle, [input('responding'), input('idle', { stopped: true, replyText: 'Partial' })])
    expect(state.polite).toEqual({ kind: 'stopped' })
  })

  it('announces a failure assertively and clears the polite region', () => {
    const state = run(idle, [input('responding'), input('settling'), input('failed')])
    expect(state).toEqual({ phase: 'failed', polite: null, assertive: { kind: 'failed' } })
  })

  it('keeps quiet through an auto-retry: no failure, and no second "responding"', () => {
    const responding = run(idle, [input('responding')])
    const settling = nextReplyAnnouncement(responding, input('settling'))
    expect(settling).toEqual({ ...responding, phase: 'settling' })
    const retrying = nextReplyAnnouncement(settling, input('responding'))
    expect(retrying).toEqual({ ...responding, phase: 'responding' })
    expect(nextReplyAnnouncement(retrying, input('idle', { replyText: 'Done' })).polite).toEqual({
      kind: 'reply',
      text: 'Done',
    })
  })

  it('announces a stop during the retry backoff as stopped', () => {
    const state = run(idle, [input('responding'), input('settling'), input('idle', { stopped: true })])
    expect(state.polite).toEqual({ kind: 'stopped' })
  })

  it('announces "responding" when a turn starts from a stale error left on mount', () => {
    const staleError: ReplyAnnouncementState = { phase: 'settling', polite: null, assertive: null }
    expect(nextReplyAnnouncement(staleError, input('responding')).polite).toEqual({ kind: 'responding' })
  })

  it('clears the previous failure when the next turn starts, so a second failure is a change', () => {
    const failed = run(idle, [input('responding'), input('failed')])
    const retried = nextReplyAnnouncement(failed, input('responding'))
    expect(retried).toEqual({ phase: 'responding', polite: { kind: 'responding' }, assertive: null })
    expect(nextReplyAnnouncement(retried, input('failed')).assertive).toEqual({ kind: 'failed' })
  })

  it('clears both regions when a failed turn goes idle without a new reply', () => {
    expect(run(idle, [input('responding'), input('failed'), input('idle')])).toEqual(idle)
  })

  it('says nothing in voice mode, which speaks the reply and announces its own status', () => {
    expect(run(idle, [input('responding', { muted: true })])).toEqual({
      phase: 'responding',
      polite: null,
      assertive: null,
    })
    expect(run(idle, [input('responding', { muted: true }), input('idle', { muted: true, replyText: 'Hi' })])).toEqual(
      idle,
    )
  })
})

describe('clearing a finished announcement', () => {
  it('treats reply, ready and stopped as finished, and leaves responding and failed alone', () => {
    expect(isFinishedAnnouncement({ kind: 'reply', text: 'Hi' })).toBe(true)
    expect(isFinishedAnnouncement({ kind: 'ready' })).toBe(true)
    expect(isFinishedAnnouncement({ kind: 'stopped' })).toBe(true)
    expect(isFinishedAnnouncement({ kind: 'responding' })).toBe(false)
    expect(isFinishedAnnouncement({ kind: 'failed' })).toBe(false)
    expect(isFinishedAnnouncement(null)).toBe(false)
  })

  it('empties the polite region and keeps the phase', () => {
    const finished = run(idle, [input('responding'), input('idle', { replyText: 'Hi' })])
    expect(clearFinishedAnnouncement(finished, finished.polite!)).toEqual(idle)
  })

  it('does nothing once a newer announcement has replaced it', () => {
    const finished = run(idle, [input('responding'), input('idle', { replyText: 'Hi' })])
    const next = nextReplyAnnouncement(finished, input('responding'))
    expect(clearFinishedAnnouncement(next, finished.polite!)).toBe(next)
  })
})
