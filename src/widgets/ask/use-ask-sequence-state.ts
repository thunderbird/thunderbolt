/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { setPendingPrompt } from '@/chats/pending-prompt-store'
import { useDatabase } from '@/contexts'
import { getMessageCache, updateMessageCache } from '@/dal/chat-messages'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useReducer } from 'react'

import type { SendStatus } from './display'
import type { AskSubmission } from './use-ask-state'
import {
  type AskCacheEntry,
  type AskData,
  askStorageKeys,
  composerDraftForAnswers,
  hasOtherAnswer,
  initialAskStep,
  isGradedMode,
  turnTextForAnswers,
} from './lib'

/** A message's saved ask responses, keyed by storage key. */
export type SavedAskEntries = Record<string, AskCacheEntry | undefined>

/** React Query key for a message's saved ask responses. */
const askQueryKey = (messageId: string) => ['askState', messageId]

/** Reads every ask response saved on a message, keyed by storage key. */
export const useSavedAskEntries = (messageId: string) => {
  const db = useDatabase()
  return useQuery({
    queryKey: askQueryKey(messageId),
    queryFn: async () => {
      const message = await getMessageCache(db, messageId)
      return (message?.cache ?? {}) as SavedAskEntries
    },
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

// Answers are a read-modify-write on one cache blob per message, so every
// sequence in a message chains its writes on the same queue.
const persistQueues = new Map<string, Promise<void>>()

/**
 * Runs `write` after every earlier write queued for the message; resolves once it has run.
 * `write` must not reject: a rejection would skip every write queued after it.
 */
const enqueuePersist = (messageId: string, write: () => Promise<void>): Promise<void> => {
  const queued = (persistQueues.get(messageId) ?? Promise.resolve()).then(write)
  persistQueues.set(messageId, queued)
  void queued.then(() => {
    if (persistQueues.get(messageId) === queued) {
      persistQueues.delete(messageId)
    }
  })
  return queued
}

type SequenceState = {
  step: number
  reviewOpen: boolean
  /** Outcome of finishing the message's answers, for the submit that finished them. */
  sendStatus: SendStatus
  /** Whether the current step was reached by navigating, rather than on mount. */
  navigated: boolean
  /**
   * When the current step was reached by navigating (`Date.now()`, taken in the
   * click handler), or `null` on mount. Its card ignores answers for a moment
   * after it, so the second click of a double click cannot answer it.
   */
  navigatedAt: number | null
  /**
   * The step answered last in this session. It enables › in the same render as
   * the answer, before the saved entry comes back through the query.
   */
  answeredStep: number | null
}

type SequenceAction =
  | { type: 'STEP_CHANGED'; step: number; at: number }
  /** `finish` is set only for the submit that leaves every ask in the message answered. */
  | { type: 'SUBMITTED'; advance: boolean; finish: 'sending' | 'handed-off' | null; at: number }
  | { type: 'SEND_SUCCEEDED' }
  | { type: 'SEND_FAILED' }
  | { type: 'SEND_FAILED_IN_CHAT' }
  | { type: 'SEND_RETRIED' }
  | { type: 'HANDED_OFF' }
  | { type: 'REVIEW_OPENED' }

/** State transitions of an ask sequence: navigation, the review, and the answer turn's send. */
export const sequenceReducer = (state: SequenceState, action: SequenceAction): SequenceState => {
  switch (action.type) {
    case 'STEP_CHANGED':
      return { ...state, step: action.step, navigated: true, navigatedAt: action.at }
    case 'SUBMITTED': {
      const submitted = { ...state, sendStatus: action.finish ?? state.sendStatus, answeredStep: state.step }
      return action.advance
        ? { ...submitted, step: state.step + 1, navigated: true, navigatedAt: action.at }
        : submitted
    }
    case 'SEND_SUCCEEDED':
      return { ...state, sendStatus: 'sent' }
    case 'SEND_FAILED':
      return { ...state, sendStatus: 'failed' }
    case 'SEND_FAILED_IN_CHAT':
      return { ...state, sendStatus: 'failed-in-chat' }
    case 'SEND_RETRIED':
      return { ...state, sendStatus: 'sending' }
    case 'HANDED_OFF':
      return { ...state, sendStatus: 'handed-off' }
    case 'REVIEW_OPENED':
      return { ...state, reviewOpen: true }
  }
}

/** How a skipped question is answered in the user turn, which shows in the user's own bubble. */
const skippedAnswer = msg`skipped`

/**
 * How long a step reached by navigating ignores answers: the second click of a
 * double click on Next (or on the option that advanced) lands on the new card,
 * where a graded `single` would grade it.
 */
const navigationGuardMs = 400

type AskSequenceStateInput = {
  /** This sequence's steps. */
  asks: AskData[]
  /** Index of the first step within `messageAsks`. */
  offset: number
  /** Every non-legacy ask in the message, in order; the turn is sent once all are answered. */
  messageAsks: AskData[]
  messageId: string
  saved: SavedAskEntries
  /** A later message exists in the thread, so this message's answers have gone out. */
  hasReply?: boolean
}

/**
 * State and actions of a one-question-at-a-time ask sequence: which step is
 * shown, persisting each answer, and — once a submit leaves every ask in the
 * message answered — sending every answer as one user turn (with a retry on
 * failure), or handing them to the composer when one is "Other…".
 */
export const useAskSequenceState = ({
  asks,
  offset,
  messageAsks,
  messageId,
  saved,
  hasReply = false,
}: AskSequenceStateInput) => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { id: threadId, chatInstance } = useCurrentChatSession()
  const messageKeys = askStorageKeys(messageAsks)
  const keys = messageKeys.slice(offset, offset + asks.length)
  const isMultiStep = asks.length > 1
  const [state, dispatch] = useReducer(sequenceReducer, undefined, (): SequenceState => {
    const answered = keys.map((key) => saved[key] !== undefined)
    // Open on the review only once the answers are locked: before that, a
    // finished group in a still-open message must keep its steps reachable.
    const messageDone = hasReply || messageKeys.every((messageKey) => saved[messageKey] !== undefined)
    return {
      step: initialAskStep(answered),
      reviewOpen: isMultiStep && !answered.includes(false) && messageDone,
      sendStatus: 'idle',
      navigated: false,
      navigatedAt: null,
      answeredStep: null,
    }
  })

  const ask = asks[state.step]
  const key = keys[state.step]
  const isLastStep = state.step === asks.length - 1
  const isSequenceDone = keys.every((stepKey) => saved[stepKey] !== undefined)

  /** Every answer in the message, in order, or `null` while any is missing. */
  const messageAnswersOf = (entries: SavedAskEntries): AskCacheEntry[] | null => {
    const answers = messageKeys.map((messageKey) => entries[messageKey])
    return answers.every((answer): answer is AskCacheEntry => answer !== undefined) ? answers : null
  }

  // Answers lock once every ask in the message is answered: from then on they
  // have gone out, gone into the composer, or failed to send (Try again resends
  // them), so a change would never reach the model. `sendStatus` covers the
  // render before the saved entry comes back through the query; `hasReply`, a
  // message whose answers went out before some of its asks were answered.
  const answersLocked =
    hasReply ||
    messageAnswersOf(saved) !== null ||
    state.sendStatus === 'sending' ||
    state.sendStatus === 'sent' ||
    state.sendStatus === 'failed-in-chat' ||
    state.sendStatus === 'handed-off'

  const persistAnswer = async (entry: AskCacheEntry) => {
    try {
      await updateMessageCache(db, messageId, key, entry)
    } catch (error) {
      // Submit is fire-and-forget from a click handler, so log rather than lose
      // the rejection; the query cache keeps the answer visible until reload.
      console.error('Ask widget failed to persist the answer', error)
    }
  }

  const send = async (turnText: string) => {
    try {
      await chatInstance.sendMessage({ text: turnText })
      // `sendMessage` catches a failed request itself and resolves with the
      // chat in error. The turn is in the thread by then, and the chat shows
      // its own error and retry: a widget retry would post it twice.
      dispatch({ type: chatInstance.error ? 'SEND_FAILED_IN_CHAT' : 'SEND_SUCCEEDED' })
    } catch (error) {
      // The answers are persisted, so nothing is lost: surface the failure and offer a retry.
      console.error('Ask widget failed to dispatch answer turn', error)
      dispatch({ type: 'SEND_FAILED' })
    }
  }

  /** Puts the answers in the composer, focused, for the user to type the "Other…" ones and send. */
  const handOff = (answers: AskCacheEntry[]) =>
    setPendingPrompt(threadId, composerDraftForAnswers(answers, i18n._(skippedAnswer)), { focus: true })

  const submit = async ({ selectedIds, matched, other, skipped }: AskSubmission) => {
    const chosen = selectedIds.map((id) => ask.options.find((option) => option.id === id)?.text ?? id)
    const entry: AskCacheEntry = {
      prompt: ask.prompt,
      mode: ask.mode,
      selectedIds,
      chosen,
      matched,
      ...(other && { other: true }),
      ...(skipped && { skipped: true }),
    }
    // Read from the query, not `saved`: a second click in the same frame (say,
    // on another option of the last `choice`) must see the first one's answer
    // and change nothing, or the turn would carry one answer and the cache another.
    if (messageAnswersOf(queryClient.getQueryData<SavedAskEntries>(askQueryKey(messageId)) ?? {})) {
      return
    }
    // Record the answer in the (infinitely-cached) query synchronously: the
    // following step — or another sequence in this message — must see it
    // before persistence settles.
    const entries =
      queryClient.setQueryData<SavedAskEntries>(askQueryKey(messageId), (prev) => ({ ...prev, [key]: entry })) ?? {}
    const persisted = enqueuePersist(messageId, () => persistAnswer(entry))

    // The submit that answers the last open ask finishes the message. Once the
    // thread has moved on it never sends: a send would start a new turn over a
    // reply that may still be streaming, and post a stale turn at the bottom. The
    // answer is saved, and the model reads it from the ask note on the next send.
    // The "Other…" hand-off still happens, since filling the composer sends nothing.
    const answers = messageAnswersOf(entries)
    const turnText =
      answers && !hasReply && !hasOtherAnswer(answers) ? turnTextForAnswers(answers, i18n._(skippedAnswer)) : null
    const finish = answers && hasOtherAnswer(answers) ? 'handed-off' : turnText ? 'sending' : null
    // A graded step stays on its feedback; anything else moves straight on.
    dispatch({
      type: 'SUBMITTED',
      advance: !isLastStep && (!isGradedMode(ask.mode) || Boolean(skipped)),
      finish,
      at: Date.now(),
    })

    if (finish === 'handed-off' && answers) {
      handOff(answers)
      return
    }
    if (!turnText) {
      return
    }
    await persisted
    await send(turnText)
  }

  const retrySend = async () => {
    // Once the thread has moved on, a retry would post a stale turn at the
    // bottom, exactly what `submit` avoids; the note carries the answers instead.
    if (hasReply) {
      return
    }
    const answers = messageAnswersOf(queryClient.getQueryData<SavedAskEntries>(askQueryKey(messageId)) ?? {})
    if (!answers) {
      return
    }
    if (hasOtherAnswer(answers)) {
      handOff(answers)
      dispatch({ type: 'HANDED_OFF' })
      return
    }
    const turnText = turnTextForAnswers(answers, i18n._(skippedAnswer))
    if (!turnText) {
      return
    }
    dispatch({ type: 'SEND_RETRIED' })
    await send(turnText)
  }

  const savedEntry = saved[key]
  const goTo = (step: number) => () => dispatch({ type: 'STEP_CHANGED', step, at: Date.now() })

  return {
    ask,
    stepKey: key,
    step: state.step,
    total: asks.length,
    isMultiStep,
    reviewOpen: state.reviewOpen,
    navigated: state.navigated,
    /** Answers on this step are ignored until then (`Date.now()` scale), just after navigating to it. */
    ignoreAnswersUntil: state.navigatedAt === null ? undefined : state.navigatedAt + navigationGuardMs,
    sendStatus: state.sendStatus,
    savedEntry,
    readOnly: savedEntry !== undefined && answersLocked,
    canSkip: Boolean(ask.optional) && messageAsks.length > 1,
    reviewItems: asks.flatMap((stepAsk, index) => {
      const entry = saved[keys[index]]
      return entry ? [{ ask: stepAsk, entry }] : []
    }),
    // The review has no way back, so it waits for the lock, not just this group.
    canReview: isMultiStep && isSequenceDone && answersLocked,
    submit,
    previous: state.step > 0 ? goTo(state.step - 1) : undefined,
    next:
      !isLastStep && (savedEntry !== undefined || state.answeredStep === state.step) ? goTo(state.step + 1) : undefined,
    openReview: () => dispatch({ type: 'REVIEW_OPENED' }),
    /** Absent once the thread has moved on, so no Try again is offered. */
    retrySend: hasReply ? undefined : retrySend,
  }
}
