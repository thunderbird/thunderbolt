/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Ask } from './display'
import { type AskArgs, askDataOf } from './group'
import { type AskData, type AskOption, askStorageKey } from './lib'
import { AskReview } from './review'
import { type SavedAskEntries, useAskSequenceState, useSavedAskEntries } from './use-ask-sequence-state'

type AskWidgetProps = AskArgs & { messageId: string }

/**
 * Read-only rendering of a legacy `free` (typed-answer) ask. The mode was
 * removed from authoring, but historical messages still carry the markup —
 * show the question and, when the user answered before the removal, their
 * recorded answer.
 */
const LegacyFreeAsk = ({ prompt, savedText }: { prompt: string; savedText: string | null }) => (
  <div className="my-4 w-full rounded-xl border border-border bg-card px-4 py-3">
    <p className="text-[length:var(--font-size-body)]">{prompt}</p>
    {savedText !== null && (
      <p className="mt-2 text-[length:var(--font-size-sm)] text-muted-foreground">Answered: “{savedText}”</p>
    )}
  </div>
)

/** Streaming placeholder for an ask, also shown while its saved answers load. */
export const Skeleton = () => <div className="my-4 h-40 w-full animate-pulse rounded-xl border border-border bg-card" />

type AskSequenceProps = {
  /** This sequence's steps. */
  asks: AskData[]
  /** Index of the first step within `messageAsks`. */
  offset: number
  /** Every non-legacy ask in the message, in order; the turn is sent once all are answered. */
  messageAsks: AskData[]
  messageId: string
  /** A later message exists in the thread, so the answers have gone out and lock. */
  hasReply?: boolean
}

/**
 * One-question-at-a-time wizard over a run of asks in a message. Each answer is
 * persisted to the message cache as it is submitted; once every ask in the
 * message is answered, all the answers go to the model in a single user turn
 * (or into the composer, when one is "Other…"). Graded steps stay on screen
 * with their feedback, and lock; the step control moves back and forth, and a
 * finished multi-step sequence can be reviewed as a whole.
 */
export const AskSequence = (props: AskSequenceProps) => {
  const { data: saved, isPending } = useSavedAskEntries(props.messageId)

  if (isPending) {
    return <Skeleton />
  }

  return <AskSequenceSteps {...props} saved={saved ?? {}} />
}

const AskSequenceSteps = (props: AskSequenceProps & { saved: SavedAskEntries }) => {
  const sequence = useAskSequenceState(props)

  if (sequence.reviewOpen) {
    return <AskReview items={sequence.reviewItems} sendStatus={sequence.sendStatus} onRetrySend={sequence.retrySend} />
  }

  const { ask } = sequence
  return (
    <Ask
      key={`${sequence.step}:${sequence.stepKey}`}
      prompt={ask.prompt}
      mode={ask.mode}
      options={ask.options}
      explanation={ask.explanation}
      initialSelectedIds={sequence.savedEntry?.selectedIds}
      initialSubmitted={sequence.savedEntry !== undefined}
      initialOther={sequence.savedEntry?.other}
      initialSkipped={sequence.savedEntry?.skipped}
      readOnly={sequence.readOnly}
      canSkip={sequence.canSkip}
      onSubmit={sequence.submit}
      progress={sequence.isMultiStep ? { step: sequence.step + 1, total: sequence.total } : undefined}
      onPrevious={sequence.previous}
      onNext={sequence.next}
      onReview={sequence.canReview ? sequence.openReview : undefined}
      sendStatus={sequence.sendStatus}
      onRetrySend={sequence.retrySend}
      focusPrompt={sequence.navigated}
      ignoreAnswersUntil={sequence.ignoreAnswersUntil}
    />
  )
}

/** Read-only ask (legacy `free`, or one without options), with its saved answer once the message cache loads. */
const LegacyFreeAskWidget = ({
  prompt,
  options,
  messageId,
}: {
  prompt: string
  options: AskOption[]
  messageId: string
}) => {
  const { data: saved, isPending } = useSavedAskEntries(messageId)

  if (isPending) {
    return <Skeleton />
  }
  const entry = saved?.[askStorageKey({ prompt, mode: 'free', options })]
  return <LegacyFreeAsk prompt={prompt} savedText={entry?.text ?? entry?.chosen[0] ?? null} />
}

/**
 * Registry entry for a lone `<widget:ask>`. The chat renderer folds every ask
 * with options into an {@link AskSequence} (which gets `hasReply`), so this
 * entry only sees a legacy `free` ask or a malformed one without options. Both
 * render the prompt read-only, so there is nothing for a reply to lock.
 */
export const AskWidget = ({ messageId, ...args }: AskWidgetProps) => {
  const ask = askDataOf(args)
  if (!ask) {
    return <LegacyFreeAskWidget prompt={args.prompt} options={args.options ?? []} messageId={messageId} />
  }
  return <AskSequence asks={[ask]} offset={0} messageAsks={[ask]} messageId={messageId} />
}
