/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { TurnActivity } from './turn-activity'

/**
 * Where the current reply stands, as far as a screen reader needs to know.
 * `settling` is an error the retry logic hasn't ruled on yet: it either retries
 * (back to `responding`) or gives up (`failed`), so it announces nothing itself.
 */
export type ReplyPhase = 'idle' | 'responding' | 'settling' | 'failed'

export type ReplyAnnouncement =
  | { kind: 'responding' }
  | { kind: 'reply'; text: string }
  | { kind: 'ready' }
  | { kind: 'stopped' }
  | { kind: 'failed' }

export type ReplyAnnouncementState = {
  phase: ReplyPhase
  /** Read by the polite live region. */
  polite: ReplyAnnouncement | null
  /** Read by the assertive live region: only a failed reply, which blocks the user. */
  assertive: ReplyAnnouncement | null
}

export type ReplyAnnouncementInput = {
  phase: ReplyPhase
  /** The user pressed Stop on this turn. */
  stopped: boolean
  /** The finished reply as speakable text, or '' when it has none (tool or widget only). */
  replyText: string
  /** Voice mode speaks the reply and announces its own status, so the chat stays quiet. */
  muted: boolean
}

/** Replies up to this many characters are read out in full; longer ones announce "Response ready". */
export const maxAnnouncedReplyLength = 280

/**
 * How long a finished-turn announcement stays in the polite region. Long enough
 * for the screen reader to pick it up, short enough that a user reading the page
 * doesn't meet the reply a second time outside the thread.
 */
export const finishedAnnouncementMs = 5000

/** Clear a finished-turn announcement once it has been read; no-op if the region has moved on. */
export const clearFinishedAnnouncement = (
  state: ReplyAnnouncementState,
  announcement: ReplyAnnouncement,
): ReplyAnnouncementState => (state.polite === announcement ? { ...state, polite: null } : state)

/** Announcements that end a turn, which {@link clearFinishedAnnouncement} removes after a delay. */
export const isFinishedAnnouncement = (announcement: ReplyAnnouncement | null): announcement is ReplyAnnouncement =>
  announcement?.kind === 'reply' || announcement?.kind === 'ready' || announcement?.kind === 'stopped'

/**
 * Collapse a turn's activity into a {@link ReplyPhase}. An error is `settling`
 * until the retry logic marks it exhausted, and a Stop during the retry backoff
 * ends the turn instead of failing it.
 */
export const getReplyPhase = (
  activity: Pick<TurnActivity, 'isActive' | 'hasError'>,
  { retriesExhausted, stopped }: { retriesExhausted: boolean; stopped: boolean },
): ReplyPhase => {
  if (activity.isActive) {
    return 'responding'
  }
  if (!activity.hasError || stopped) {
    return 'idle'
  }
  return retriesExhausted ? 'failed' : 'settling'
}

const finishedAnnouncement = ({ stopped, replyText }: ReplyAnnouncementInput): ReplyAnnouncement => {
  if (stopped) {
    return { kind: 'stopped' }
  }
  if (replyText && replyText.length <= maxAnnouncedReplyLength) {
    return { kind: 'reply', text: replyText }
  }
  return { kind: 'ready' }
}

/**
 * Advance the live-region state on a phase change. Only transitions announce,
 * so mounting mid-turn or on a settled chat stays silent and streamed tokens are
 * never read. Each new turn replaces both regions' text, so a reply identical
 * to the last one, or a second failure in a row, still counts as a change.
 */
export const nextReplyAnnouncement = (
  state: ReplyAnnouncementState,
  input: ReplyAnnouncementInput,
): ReplyAnnouncementState => {
  const { phase } = input
  if (phase === state.phase) {
    return state
  }
  if (input.muted) {
    return { phase, polite: null, assertive: null }
  }
  switch (phase) {
    case 'responding':
      // A retry after a settling error is the same reply still on its way.
      return state.polite?.kind === 'responding'
        ? { ...state, phase }
        : { phase, polite: { kind: 'responding' }, assertive: null }
    case 'settling':
      return { ...state, phase }
    case 'failed':
      return { phase, polite: null, assertive: { kind: 'failed' } }
    case 'idle':
      return state.phase === 'responding' || state.phase === 'settling'
        ? { phase, polite: finishedAnnouncement(input), assertive: null }
        : { phase, polite: null, assertive: null }
  }
}
