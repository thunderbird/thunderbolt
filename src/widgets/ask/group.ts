/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ContentPart } from '@/ai/widget-parser'
import type { AskData, AskMode, AskOption } from './lib'

export type AskSequencePart = {
  type: 'ask-sequence'
  asks: AskData[]
  /** Index of this sequence's first ask among every ask in the message. */
  offset: number
}

/** An ask widget's parsed attributes, as the schema hands them over. */
export type AskArgs = {
  prompt: string
  mode: AskData['mode'] | 'free'
  options?: AskData['options']
  explanation?: string
  optional?: string
}

/** The ungraded mode a graded one falls back to when no option is marked `isCorrect`. */
const ungradedModes = { single: 'choice', multiple: 'choices' } as const

/**
 * The mode an ask is shown in. A `single`/`multiple` with no option marked
 * `isCorrect` has no answer to grade against: grading it would mark every pick
 * wrong, so it is shown as `choice`/`choices` instead.
 */
const shownMode = (mode: AskMode, options: AskOption[]): AskMode =>
  (mode === 'single' || mode === 'multiple') && !options.some((option) => option.isCorrect) ? ungradedModes[mode] : mode

/**
 * The {@link AskData} an ask widget's attributes describe, or `null` for a
 * legacy `free` or option-less ask, which renders read-only on its own and
 * never joins a sequence. A graded ask without an answer key becomes ungraded
 * (see {@link shownMode}), keeping its authored mode for the storage key.
 */
export const askDataOf = ({ prompt, mode, options, explanation, optional }: AskArgs): AskData | null => {
  if (mode === 'free' || !options) {
    return null
  }
  const shown = shownMode(mode, options)
  return {
    prompt,
    mode: shown,
    options,
    explanation,
    ...(optional === 'true' && { optional: true }),
    ...(shown !== mode && { authoredMode: mode }),
  }
}

/** The ask a content part carries, or `null` for anything else — including legacy `free` and option-less asks. */
const toAskData = (part: ContentPart): AskData | null =>
  part.type === 'widget' && part.widget.widget === 'ask' ? askDataOf(part.widget.args as AskArgs) : null

const isBlankText = (part: ContentPart): boolean => part.type === 'text' && part.content.trim() === ''

/** How many asks the sequences among `parts` hold — the offset of the next sequence. */
const countAsks = (parts: (ContentPart | AskSequencePart)[]): number =>
  parts.reduce((count, part) => (part.type === 'ask-sequence' ? count + part.asks.length : count), 0)

/**
 * Collapses runs of ask widgets (separated by nothing but whitespace) into one
 * {@link AskSequencePart}, so a multi-question quiz renders as a single
 * one-question-at-a-time wizard instead of a stack of independent cards.
 */
export const groupAskSequences = (parts: ContentPart[]): (ContentPart | AskSequencePart)[] => {
  const grouped: (ContentPart | AskSequencePart)[] = []
  // Blank text seen after an ask, held back until we know whether another ask follows.
  const pendingBlanks: ContentPart[] = []

  for (const part of parts) {
    const ask = toAskData(part)
    const last = grouped.at(-1)
    if (ask) {
      if (last?.type === 'ask-sequence') {
        last.asks.push(ask)
        pendingBlanks.length = 0
      } else {
        grouped.push(...pendingBlanks.splice(0), { type: 'ask-sequence', asks: [ask], offset: countAsks(grouped) })
      }
      continue
    }
    if (last?.type === 'ask-sequence' && isBlankText(part)) {
      pendingBlanks.push(part)
      continue
    }
    // An ask still streaming in joins the sequence, which already shows a placeholder.
    if (last?.type === 'ask-sequence' && part.type === 'widget-loading' && part.name === 'ask') {
      pendingBlanks.length = 0
      continue
    }
    grouped.push(...pendingBlanks.splice(0), part)
  }

  return [...grouped, ...pendingBlanks]
}

/** Every ask in grouped parts, in message order — what a sequence's {@link AskSequencePart.offset} indexes. */
export const messageAsksOf = (parts: (ContentPart | AskSequencePart)[]): AskData[] =>
  parts.flatMap((part) => (part.type === 'ask-sequence' ? part.asks : []))
