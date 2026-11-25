/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useRef } from 'react'

import { evaluateAnswer, isGradedMode, isMultiSelectMode, type AskData } from './lib'

export type AskSubmission = {
  selectedIds: string[]
  /** Whether the selection matched the designated answer; `null` when there is none. */
  matched: boolean | null
  /** The user picked "Other…" and types the rest in the composer. */
  other?: boolean
  /** The user skipped the question. */
  skipped?: boolean
}

/** A previously-submitted response, restored from the message cache. */
export type SavedAskAnswer = {
  initialSelectedIds?: string[]
  initialSubmitted?: boolean
  initialOther?: boolean
  initialSkipped?: boolean
}

type AskStateInput = Pick<AskData, 'prompt' | 'mode' | 'options'> &
  SavedAskAnswer & {
    /** The answer can no longer change, and the card shows the saved one. */
    readOnly?: boolean
    /** Offers Skip, for an optional question in a message with others to answer. */
    canSkip?: boolean
    /** Fired when the user commits a response; again for each edit of an ungraded one. */
    onSubmit?: (submission: AskSubmission) => void
    /**
     * Ignore answers until then (`Date.now()` scale): a step just reached by
     * navigating must not take the second click of a double click.
     */
    ignoreAnswersUntil?: number
  }

/** A response as the card holds it: the picked options, "Other…", or a skip. */
type AskAnswer = { selected: Set<string>; other: boolean; skipped: boolean }

const skipAnswer: AskAnswer = { selected: new Set(), other: false, skipped: true }

/** Identifies an answer, so re-committing the same one (a double click) is a no-op. */
const answerSignature = ({ selected, other, skipped }: AskAnswer): string =>
  skipped ? 'skipped' : JSON.stringify({ ids: [...selected].sort(), other })

type AskUiState = AskAnswer & {
  submitted: boolean
  /** Signature of the last committed answer, or `null` before the first. */
  committed: string | null
  /** Whether an answer was committed on this card, rather than restored. */
  committedHere: boolean
}

/** The card's state for a saved answer (or none), as restored on mount. */
const savedUiState = ({
  initialSelectedIds,
  initialSubmitted,
  initialOther,
  initialSkipped,
}: SavedAskAnswer): AskUiState => {
  const answer = {
    selected: new Set(initialSelectedIds),
    other: initialOther ?? false,
    skipped: initialSkipped ?? false,
  }
  return {
    ...answer,
    submitted: (initialSubmitted ?? false) && !answer.skipped,
    committed: initialSubmitted || answer.skipped ? answerSignature(answer) : null,
    committedHere: false,
  }
}

type AskUiAction =
  | { type: 'OPTION_TOGGLED'; id: string; isMultiple: boolean }
  | { type: 'OTHER_TOGGLED'; isMultiple: boolean }
  | { type: 'COMMITTED'; answer: AskAnswer }

const askUiReducer = (state: AskUiState, action: AskUiAction): AskUiState => {
  switch (action.type) {
    case 'OPTION_TOGGLED': {
      if (!action.isMultiple) {
        return { ...state, selected: new Set([action.id]), other: false }
      }
      const selected = new Set(state.selected)
      selected.has(action.id) ? selected.delete(action.id) : selected.add(action.id)
      return { ...state, selected }
    }
    case 'OTHER_TOGGLED':
      // In a single-select mode "Other…" is one of the choices, so it replaces the pick.
      return action.isMultiple ? { ...state, other: !state.other } : { ...state, selected: new Set(), other: true }
    case 'COMMITTED':
      return {
        ...action.answer,
        submitted: !action.answer.skipped,
        committed: answerSignature(action.answer),
        committedHere: true,
      }
  }
}

/**
 * The answer rules of one ask card: what is selected, when it commits (on
 * click for a graded `single`, on the action button otherwise), that a graded answer
 * commits once and an ungraded one again only when it changes, and that a
 * locked card shows the saved answer.
 */
export const useAskState = ({
  prompt,
  mode,
  options,
  readOnly = false,
  canSkip = false,
  onSubmit,
  ignoreAnswersUntil,
  ...saved
}: AskStateInput) => {
  const [ownState, dispatch] = useReducer(askUiReducer, saved, savedUiState)
  // A locked card shows the saved answer, not a selection left pending (or a
  // click the sequence ignored) when it locked.
  const state = readOnly ? { ...savedUiState(saved), committedHere: ownState.committedHere } : ownState
  // Synchronous re-entry guard for the `onSubmit` side effect: `state.committed`
  // lags a render behind, so a rapid double-click would otherwise commit (and
  // send the turn) twice before React re-renders. A side-effect latch, not UI
  // state, so it lives outside the reducer.
  const committedRef = useRef(ownState.committed)

  const isGraded = isGradedMode(mode)
  const isMultiple = isMultiSelectMode(mode)
  // A graded `single` is graded the instant an option is tapped. Every other
  // mode shows the pick first and commits on the action button, so the user
  // sees what they tapped before it counts.
  const commitsOnClick = mode === 'single'
  const showsGrade = isGraded && state.submitted
  const locked = readOnly || showsGrade

  const commit = (answer: AskAnswer) => {
    const signature = answerSignature(answer)
    const gradedAlready = isGraded && committedRef.current !== null && committedRef.current !== 'skipped'
    if (committedRef.current === signature || gradedAlready) {
      return
    }
    committedRef.current = signature
    dispatch({ type: 'COMMITTED', answer })
    onSubmit?.({
      selectedIds: [...answer.selected],
      matched: answer.skipped ? null : evaluateAnswer({ prompt, mode, options }, answer.selected),
      ...(answer.other && { other: true }),
      ...(answer.skipped && { skipped: true }),
    })
  }

  // Read in the handlers, not during render, so no effect or timer is needed.
  const isIgnoringAnswers = () => ignoreAnswersUntil !== undefined && Date.now() < ignoreAnswersUntil

  const toggleOption = (id: string) => {
    if (locked || isIgnoringAnswers()) {
      return
    }
    if (commitsOnClick) {
      commit({ selected: new Set([id]), other: false, skipped: false })
      return
    }
    dispatch({ type: 'OPTION_TOGGLED', id, isMultiple })
  }

  const toggleOther = () => {
    if (locked || isIgnoringAnswers()) {
      return
    }
    // "Other…" is offered on ungraded modes only, none of which commits on click.
    dispatch({ type: 'OTHER_TOGGLED', isMultiple })
  }

  const pending: AskAnswer = { selected: state.selected, other: state.other, skipped: false }
  const hasPick = state.selected.size > 0 || state.other

  // Skip and Submit are guarded too: the second click of a double click on Next
  // can land on the new card's Skip, which sits where Next was when it has no Submit.
  const submit = () => {
    if (!isIgnoringAnswers()) {
      commit(pending)
    }
  }

  const skip = () => {
    if (!isIgnoringAnswers()) {
      commit(skipAnswer)
    }
  }

  return {
    selected: state.selected,
    other: state.other,
    skipped: state.skipped,
    isGraded,
    isMultiple,
    /** "Other…" is offered on the ungraded modes only. */
    offersOther: !isGraded,
    /** The right/wrong colours (and the explanation) show. */
    showsGrade,
    locked,
    /** Whether an answer was committed on this card, rather than restored. */
    committedHere: state.committedHere,
    answered: state.submitted || state.skipped,
    /** Whether the answer given here matched, for the screen-reader announcement; `null` when there is none to announce. */
    announcedMatch:
      showsGrade && state.committedHere ? evaluateAnswer({ prompt, mode, options }, state.selected) : null,
    // Submit appears while there is something new to commit: before the first
    // answer, and on an ungraded step once its selection is edited. A skipped
    // step counts as edited only once something is picked, so going back to it
    // doesn't block moving on.
    showSubmit: !commitsOnClick && !locked && (state.skipped ? hasPick : state.committed !== answerSignature(pending)),
    canSubmit: hasPick,
    showSkip: canSkip && !locked && !state.skipped,
    toggleOption,
    toggleOther,
    submit,
    skip,
  }
}
