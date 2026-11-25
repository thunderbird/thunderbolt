/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Lightbulb, PenLine, Sparkles, X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { optionLetter, type AskData, type AskOption } from './lib'
import { AskStepControl } from './step-control'
import { type AskSubmission, type SavedAskAnswer, useAskState } from './use-ask-state'

type AskProps = AskData &
  SavedAskAnswer & {
    /**
     * The answer can no longer change: every ask in the message is answered, or
     * the thread has moved on. The card then shows the saved answer. A graded
     * step also locks on its own once answered.
     */
    readOnly?: boolean
    /** Fired when the user commits a response, for persistence; again for each edit of an ungraded one. */
    onSubmit?: (submission: AskSubmission) => void
    /** Offers Skip, for an optional question in a message with others to answer. */
    canSkip?: boolean
    /** Position within a multi-question sequence (1-based); omitted for a lone ask. */
    progress?: { step: number; total: number }
    /** Goes back a step; omitted on the first. */
    onPrevious?: () => void
    /** Moves on a step; omitted until this one is answered, and on the last. */
    onNext?: () => void
    /** Opens the review of a finished sequence; shown once this one is answered. */
    onReview?: () => void
    /** Outcome of sending the message's answers to the model; shown on the step that sent them. */
    sendStatus?: SendStatus
    /** Resends the answers after a failed send. */
    onRetrySend?: () => void
    /** Moves focus to the prompt on mount, for a step reached by navigating the sequence. */
    focusPrompt?: boolean
    /** Ignore answers until then (`Date.now()` scale), just after the step is reached by navigating. */
    ignoreAnswersUntil?: number
  }

/** Visual state of a single option, derived from selection + submission. */
type OptionStatus = 'idle' | 'selected' | 'correct' | 'incorrect' | 'missed'

const getOptionStatus = ({
  option,
  isSelected,
  graded,
}: {
  option: AskOption
  isSelected: boolean
  /** Whether a graded answer has been given, so the right/wrong colours show. */
  graded: boolean
}): OptionStatus => {
  if (!graded) {
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
  correct: 'border-success/60 bg-success/10',
  incorrect: 'border-destructive/60 bg-destructive/10',
  missed: 'border-success/40 bg-success/5',
}

const badgeStyles: Record<OptionStatus, string> = {
  idle: 'border-border text-muted-foreground',
  selected: 'border-primary bg-primary text-primary-foreground',
  correct: 'border-success bg-success text-success-foreground',
  // White like the destructive button; destructive-foreground is dark.
  incorrect: 'border-destructive bg-destructive text-white',
  missed: 'border-success text-success',
}

type OptionRowProps = {
  badge: ReactNode
  status: OptionStatus
  /** Whether the option is part of the answer (or the pending selection). */
  pressed: boolean
  isMultiple: boolean
  disabled: boolean
  onClick: () => void
  children: ReactNode
}

const OptionRow = ({ badge, status, pressed, isMultiple, disabled, onClick, children }: OptionRowProps) => (
  <button
    type="button"
    aria-pressed={pressed}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      'group flex w-full items-center gap-3 rounded-lg border px-3.5 text-left transition-all',
      'min-h-[var(--touch-height-lg)] py-2.5',
      'disabled:cursor-default focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
      !disabled && 'cursor-pointer active:scale-[0.99]',
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
      {badge}
    </span>
    <span className="flex-1 text-[length:var(--font-size-sm)] leading-snug text-foreground">{children}</span>
  </button>
)

export const Ask = ({
  prompt,
  mode,
  options,
  explanation,
  initialSelectedIds,
  initialSubmitted,
  initialOther,
  initialSkipped,
  readOnly = false,
  onSubmit,
  canSkip = false,
  progress,
  onPrevious,
  onNext,
  onReview,
  sendStatus = 'idle',
  onRetrySend,
  focusPrompt,
  ignoreAnswersUntil,
}: AskProps) => {
  const { t } = useLingui()
  const progressId = useId()
  const promptRef = useRef<HTMLParagraphElement>(null)
  // A step reached via the step control (or an auto-advance) takes focus so the
  // new question, described by its "Question N of M" label, is announced.
  useEffect(() => {
    if (focusPrompt) {
      promptRef.current?.focus()
    }
  }, [focusPrompt])
  const nextRef = useRef<HTMLButtonElement>(null)
  const ask = useAskState({
    prompt,
    mode,
    options,
    initialSelectedIds,
    initialSubmitted,
    initialOther,
    initialSkipped,
    readOnly,
    canSkip,
    onSubmit,
    ignoreAnswersUntil,
  })
  const { isGraded, isMultiple, showsGrade, locked } = ask
  const canGoNext = Boolean(onNext)
  const hasNextStep = progress !== undefined && progress.step < progress.total
  const showNext = ask.answered && canGoNext && !ask.showSubmit
  const showReview = ask.answered && Boolean(onReview)
  // Answering locks the options, which drops focus to the page. Pick it up on
  // the Next button under the answer, or on the prompt when there is no next
  // step (Tab then reaches "See all answers").
  useEffect(() => {
    if (!ask.committedHere || !locked) {
      return
    }
    const target = canGoNext ? nextRef.current : promptRef.current
    target?.focus()
  }, [ask.committedHere, locked, canGoNext])

  const label = isMultiple ? t`Select all that apply` : isGraded ? t`Choose one` : t`Your call`

  return (
    <div className="my-4 w-full">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-4 p-4 md:p-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex min-h-[var(--touch-height-sm)] items-center gap-1.5 text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-[var(--icon-size-sm)]" />
              <span>{label}</span>
              {progress && (
                <AskStepControl
                  labelId={progressId}
                  step={progress.step}
                  total={progress.total}
                  onPrevious={onPrevious}
                  // An edit not yet saved would be dropped by ›: the button under the options saves it and moves on.
                  onNext={ask.showSubmit ? undefined : onNext}
                />
              )}
            </div>
            <p
              ref={promptRef}
              tabIndex={-1}
              aria-describedby={progress ? progressId : undefined}
              className="text-[length:var(--font-size-body)] font-medium leading-snug text-foreground focus:outline-none"
            >
              {prompt}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {options.map((option, index) => {
              const isSelected = ask.selected.has(option.id)
              const status = getOptionStatus({ option, isSelected, graded: showsGrade })
              return (
                <OptionRow
                  key={option.id}
                  status={status}
                  pressed={isSelected}
                  isMultiple={isMultiple}
                  disabled={locked}
                  onClick={() => ask.toggleOption(option.id)}
                  badge={
                    status === 'correct' || status === 'missed' ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : status === 'incorrect' ? (
                      <X className="size-3.5" strokeWidth={3} />
                    ) : (
                      optionLetter(index)
                    )
                  }
                >
                  {option.text}
                </OptionRow>
              )
            })}
            {ask.offersOther && (
              <OptionRow
                status={ask.other ? 'selected' : 'idle'}
                pressed={ask.other}
                isMultiple={isMultiple}
                disabled={locked}
                onClick={ask.toggleOther}
                badge={<PenLine className="size-3.5" />}
              >
                <Trans>Other…</Trans>
              </OptionRow>
            )}
          </div>

          {ask.skipped && (
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              <Trans>Skipped</Trans>
            </p>
          )}

          {/* Present before the grade so screen readers pick up the change; only a grade given here is announced. */}
          <p className="sr-only" aria-live="polite">
            {ask.announcedMatch === null
              ? ''
              : ask.announcedMatch
                ? t`Matches the answer`
                : t`Doesn't match the answer`}
          </p>

          {showsGrade && explanation && (
            <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3 text-[length:var(--font-size-sm)]">
              <Lightbulb className="mt-0.5 size-[var(--icon-size-sm)] shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-1">
                <span className="font-medium">
                  <Trans>Answer</Trans>
                </span>
                <span className="text-foreground/80">{explanation}</span>
              </div>
            </div>
          )}

          {/* One action row at the foot of the card, so the button stays put as feedback appears above it. */}
          {(ask.showSubmit || ask.showSkip || showNext || showReview) && (
            <div className="flex flex-col-reverse gap-2 md:flex-row md:items-center md:justify-end">
              {showReview && (
                <Button variant="outline" size="default" onClick={onReview} className="md:mr-auto">
                  <Trans>See all answers</Trans>
                </Button>
              )}
              {ask.showSkip && (
                <Button variant="ghost" size="default" onClick={ask.skip}>
                  <Trans>Skip</Trans>
                </Button>
              )}
              {ask.showSubmit ? (
                <Button size="default" disabled={!ask.canSubmit} onClick={ask.submit}>
                  {/* An ungraded step with a step after it saves and moves on in one press. */}
                  {!isGraded && hasNextStep ? <Trans>Next</Trans> : <Trans>Submit</Trans>}
                </Button>
              ) : (
                showNext && (
                  <Button ref={nextRef} size="default" onClick={onNext}>
                    <Trans>Next</Trans>
                  </Button>
                )
              )}
            </div>
          )}

          <SendStatusNote status={sendStatus} onRetry={onRetrySend} />
        </div>
      </div>
    </div>
  )
}

/**
 * Where sending a message's answers to the model stands: not yet, in flight,
 * done, or handed to the composer for an "Other…" answer to be typed. `failed`
 * means the turn never left (the widget offers Try again); `failed-in-chat`
 * means it reached the thread and the request failed there, so the chat shows
 * its own error and retry and the widget shows nothing.
 */
export type SendStatus = 'idle' | 'sending' | 'sent' | 'failed' | 'failed-in-chat' | 'handed-off'

/**
 * Confirms the answers went to the model as a user turn, points to the
 * composer when an "Other…" answer waits there, or — when the send failed —
 * says so and offers to resend them.
 */
export const SendStatusNote = ({ status, onRetry }: { status: SendStatus; onRetry?: () => void }) => {
  if (status === 'sent') {
    return (
      <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] text-muted-foreground">
        <Lightbulb className="size-[var(--icon-size-sm)] shrink-0" />
        <span>
          <Trans>Got it, working on that next.</Trans>
        </span>
      </div>
    )
  }
  if (status === 'handed-off') {
    return (
      <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] text-muted-foreground">
        <PenLine className="size-[var(--icon-size-sm)] shrink-0" />
        <span>
          <Trans>Finish your answer in the message box.</Trans>
        </span>
      </div>
    )
  }
  if (status !== 'failed') {
    return null
  }
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--font-size-sm)] text-destructive">
      <span className="flex-1">
        <Trans>Your answers couldn’t be sent.</Trans>
      </span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      )}
    </div>
  )
}
