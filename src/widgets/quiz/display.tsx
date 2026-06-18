/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Lightbulb, Sparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { gradeQuiz, optionLetter, type QuizData, type QuizOption } from './lib'

export type QuizSubmission = {
  selectedIds: string[]
  correct: boolean | null
}

type QuizProps = QuizData & {
  /** Restores a previously-answered quiz (from the message cache). */
  initialSelectedIds?: string[]
  initialSubmitted?: boolean
  /** Fired once when the user commits an answer, for persistence. */
  onSubmit?: (submission: QuizSubmission) => void
}

/** Visual state of a single option, derived from selection + submission. */
type OptionStatus = 'idle' | 'selected' | 'correct' | 'incorrect' | 'missed'

const getOptionStatus = ({
  option,
  isSelected,
  submitted,
  isGraded,
}: {
  option: QuizOption
  isSelected: boolean
  submitted: boolean
  isGraded: boolean
}): OptionStatus => {
  if (!submitted || !isGraded) {
    return isSelected ? 'selected' : 'idle'
  }
  if (option.isCorrect && isSelected) return 'correct'
  if (option.isCorrect && !isSelected) return 'missed'
  if (!option.isCorrect && isSelected) return 'incorrect'
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

export const Quiz = ({
  prompt,
  mode,
  options,
  explanation,
  initialSelectedIds,
  initialSubmitted,
  onSubmit,
}: QuizProps) => {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds))
  const [submitted, setSubmitted] = useState(initialSubmitted ?? false)

  const isGraded = mode !== 'choice'
  const isMultiple = mode === 'multiple'
  const result = useMemo(
    () => (submitted ? gradeQuiz({ prompt, mode, options }, selected) : null),
    [submitted, prompt, mode, options, selected],
  )

  const commit = (ids: Set<string>) => {
    setSubmitted(true)
    onSubmit?.({
      selectedIds: [...ids],
      correct: gradeQuiz({ prompt, mode, options }, ids),
    })
  }

  const toggleOption = (id: string) => {
    if (submitted) return

    if (!isGraded) {
      // `choice` mode: selecting an option commits the choice immediately.
      const next = new Set([id])
      setSelected(next)
      commit(next)
      return
    }

    setSelected((prev) => {
      if (isMultiple) {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      }
      return new Set([id])
    })
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
              const isSelected = selected.has(option.id)
              const status = getOptionStatus({ option, isSelected, submitted, isGraded })
              const showCorrect = status === 'correct' || status === 'missed'
              const showIncorrect = status === 'incorrect'

              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={submitted}
                  onClick={() => toggleOption(option.id)}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-xl border px-3.5 text-left transition-all',
                    'min-h-[var(--touch-height-lg)] py-2.5',
                    'disabled:cursor-default focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    !submitted && 'cursor-pointer active:scale-[0.99]',
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

          {isGraded && !submitted && (
            <Button
              size="default"
              disabled={selected.size === 0}
              onClick={() => commit(selected)}
              className="w-full md:w-auto md:self-end"
            >
              Check answer
            </Button>
          )}

          {submitted && isGraded && (
            <div
              className={cn(
                'flex items-start gap-2.5 rounded-xl border p-3 text-[length:var(--font-size-sm)]',
                result
                  ? 'border-emerald-500/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
                  : 'border-red-500/40 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200',
              )}
            >
              <span className="mt-0.5 shrink-0">
                {result ? (
                  <Check className="size-[var(--icon-size-sm)]" strokeWidth={2.5} />
                ) : (
                  <X className="size-[var(--icon-size-sm)]" strokeWidth={2.5} />
                )}
              </span>
              <div className="flex flex-col gap-1">
                <span className="font-medium">{result ? 'Correct!' : 'Not quite.'}</span>
                {explanation && <span className="text-foreground/80">{explanation}</span>}
              </div>
            </div>
          )}

          {submitted && !isGraded && (
            <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] text-muted-foreground">
              <Lightbulb className="size-[var(--icon-size-sm)] shrink-0" />
              <span>Got it — working on that next.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
