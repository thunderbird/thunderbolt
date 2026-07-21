/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Lightbulb, Sparkles, X } from 'lucide-react'
import { useReducer, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { evaluateAnswer, optionLetter, type AskData, type AskOption } from './lib'

export type AskSubmission = {
  selectedIds: string[]
  /** Whether the selection matched the designated answer; `null` when there is none. */
  matched: boolean | null
}

type AskProps = AskData & {
  /** Restores a previously-submitted response (from the message cache). */
  initialSelectedIds?: string[]
  initialSubmitted?: boolean
  /** Fired once when the user commits a response, for persistence. */
  onSubmit?: (submission: AskSubmission) => void
}

/** Visual state of a single option, derived from selection + submission. */
type OptionStatus = 'idle' | 'selected' | 'correct' | 'incorrect' | 'missed'

const getOptionStatus = ({
  option,
  isSelected,
  submitted,
  isGraded,
}: {
  option: AskOption
  isSelected: boolean
  submitted: boolean
  isGraded: boolean
}): OptionStatus => {
  if (!submitted || !isGraded) {
    return isSelected ? 'selected' : 'idle'
  }
  if (option.isCorrect && isSelected) {
    return 'correct'
  }
  if (option.isCorrect && !isSelected) {
    return 'missed'
  }
  if (!option.isCorrect && isSelected) {
    return 'incorrect'
  }
  return 'idle'
}

const statusStyles: Record<OptionStatus, string> = {
  idle: 'border-border bg-card hover:bg-accent hover:border-border',
  selected: 'border-primary bg-accent ring-1 ring-primary',
  correct: 'border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/30',
  incorrect: 'border-red-500/60 bg-red-50 dark:bg-red-950/30',
  missed: 'border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-950/15',
}

const badgeStyles: Record<OptionStatus, string> = {
  idle: 'border-border text-muted-foreground',
  selected: 'border-primary bg-primary text-primary-foreground',
  correct: 'border-emerald-500 bg-emerald-500 text-white',
  incorrect: 'border-red-500 bg-red-500 text-white',
  missed: 'border-emerald-500 text-emerald-600 dark:text-emerald-400',
}

type AskUiState = { selected: Set<string>; submitted: boolean }

type AskUiAction =
  | { type: 'OPTION_TOGGLED'; id: string; isMultiple: boolean }
  | { type: 'SUBMITTED'; selected: Set<string> }

const askUiReducer = (state: AskUiState, action: AskUiAction): AskUiState => {
  switch (action.type) {
    case 'OPTION_TOGGLED': {
      if (!action.isMultiple) {
        return { ...state, selected: new Set([action.id]) }
      }
      const selected = new Set(state.selected)
      selected.has(action.id) ? selected.delete(action.id) : selected.add(action.id)
      return { ...state, selected }
    }
    case 'SUBMITTED':
      return { ...state, submitted: true, selected: action.selected }
  }
}

export const Ask = ({
  prompt,
  mode,
  options,
  explanation,
  initialSelectedIds,
  initialSubmitted,
  onSubmit,
}: AskProps) => {
  const [state, dispatch] = useReducer(askUiReducer, undefined, () => ({
    selected: new Set(initialSelectedIds),
    submitted: initialSubmitted ?? false,
  }))
  // Synchronous re-entry guard for the `onSubmit` side effect: `state.submitted`
  // lags a render behind, so a rapid double-click would otherwise fire `onSubmit`
  // (and the user turn it dispatches) twice before React updates the disabled UI.
  // This is a side-effect latch, not UI state, so it lives outside the reducer.
  const committedRef = useRef(initialSubmitted ?? false)

  const isGraded = mode === 'single' || mode === 'multiple'
  const isMultiple = mode === 'multiple'

  const commit = (ids: Set<string>) => {
    if (committedRef.current) {
      return
    }
    committedRef.current = true
    dispatch({ type: 'SUBMITTED', selected: ids })
    onSubmit?.({
      selectedIds: [...ids],
      matched: evaluateAnswer({ prompt, mode, options }, ids),
    })
  }

  const toggleOption = (id: string) => {
    if (state.submitted) {
      return
    }
    if (!isGraded) {
      // `choice` mode: selecting an option commits the choice immediately.
      commit(new Set([id]))
      return
    }
    dispatch({ type: 'OPTION_TOGGLED', id, isMultiple })
  }

  const label = isGraded ? (isMultiple ? 'Select all that apply' : 'Choose one') : 'Your call'

  return (
    <div className="my-4 w-full">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-col gap-4 p-4 md:p-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-[var(--icon-size-sm)]" />
              <span>{label}</span>
            </div>
            <p className="text-[length:var(--font-size-body)] font-medium leading-snug text-foreground">{prompt}</p>
          </div>

          <div className="flex flex-col gap-2">
            {options.map((option, index) => {
              const isSelected = state.selected.has(option.id)
              const status = getOptionStatus({ option, isSelected, submitted: state.submitted, isGraded })
              const showCorrect = status === 'correct' || status === 'missed'
              const showIncorrect = status === 'incorrect'

              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={state.submitted}
                  onClick={() => toggleOption(option.id)}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-xl border px-3.5 text-left transition-all',
                    'min-h-[var(--touch-height-lg)] py-2.5',
                    'disabled:cursor-default focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    !state.submitted && 'cursor-pointer active:scale-[0.99]',
                    statusStyles[status],
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center border text-[length:var(--font-size-xs)] font-semibold transition-colors',
                      isMultiple ? 'rounded-md' : 'rounded-full',
                      badgeStyles[status],
                    )}
                  >
                    {showCorrect ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : showIncorrect ? (
                      <X className="size-3.5" strokeWidth={3} />
                    ) : (
                      optionLetter(index)
                    )}
                  </span>
                  <span className="flex-1 text-[length:var(--font-size-sm)] leading-snug text-foreground">
                    {option.text}
                  </span>
                </button>
              )
            })}
          </div>

          {isGraded && !state.submitted && (
            <Button
              size="default"
              disabled={state.selected.size === 0}
              onClick={() => commit(state.selected)}
              className="w-full md:w-auto md:self-end"
            >
              Submit
            </Button>
          )}

          {state.submitted && isGraded && explanation && (
            <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 p-3 text-[length:var(--font-size-sm)]">
              <Lightbulb className="mt-0.5 size-[var(--icon-size-sm)] shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-1">
                <span className="font-medium">Answer</span>
                <span className="text-foreground/80">{explanation}</span>
              </div>
            </div>
          )}

          {state.submitted && mode === 'choice' && (
            <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] text-muted-foreground">
              <Lightbulb className="size-[var(--icon-size-sm)] shrink-0" />
              <span>Got it, working on that next.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
