/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'

/**
 * Ask widget interaction modes:
 * - `single`   — exactly one designated answer (radio-style, graded)
 * - `multiple` — one or more designated answers (checkbox-style, graded)
 * - `choice`   — no designated answer, user picks one (e.g. "What do you want to do next?")
 * - `choices`  — no designated answer, user picks one or more (a preference/opinion
 *                question, e.g. "Which of these do you like?")
 *
 * The ungraded modes also offer "Other…", which hands the answer to the
 * composer for the user to type (see {@link composerDraftForAnswers}).
 *
 * (A `free` text-response mode existed briefly and was removed — typing an
 * answer belongs in the regular composer. Historical `free` widgets still
 * parse and render read-only (see `schema.ts` / `LegacyFreeAsk`), and cached
 * `free` entries still report to the model; see {@link formatAskResponsesNote}.)
 *
 * The array is the single source for the schema's `z.enum`, so the type and
 * the wire validation can't drift.
 */
export const askModes = ['single', 'multiple', 'choice', 'choices'] as const
export type AskMode = (typeof askModes)[number]

/** Graded modes have designated answer(s) and reveal right/wrong feedback on
 *  submit. Ungraded modes (`choice` / `choices`) just record the selection. */
export const isGradedMode = (mode: AskMode): boolean => mode === 'single' || mode === 'multiple'

/** Modes where the user may select more than one option. */
export const isMultiSelectMode = (mode: AskMode): boolean => mode === 'multiple' || mode === 'choices'

export type AskOption = {
  id: string
  text: string
  /** Marks a designated answer. Only meaningful for `single` / `multiple`. Ignored for `choice`. */
  isCorrect?: boolean
}

export type AskData = {
  /** The question or prompt shown above the options. */
  prompt: string
  mode: AskMode
  /** Selectable options. */
  options: AskOption[]
  /**
   * Optional context shown after the user responds — for modes with a
   * designated answer it explains that answer.
   */
  explanation?: string
  /** The user may skip this question (the `optional="true"` attribute). */
  optional?: boolean
  /**
   * The mode the model wrote, when it differs from `mode`: a `single`/`multiple`
   * with no option marked `isCorrect` is shown as `choice`/`choices` (see
   * `askDataOf`). The storage key hashes this one, so saved answers keep their key.
   */
  authoredMode?: AskMode
}

/**
 * Compares a set of selected option ids against the designated answer(s).
 * Returns `null` for ungraded modes without a designated answer (`choice` / `choices`).
 */
export const evaluateAnswer = (data: AskData, selectedIds: Set<string>): boolean | null => {
  if (!isGradedMode(data.mode)) {
    return null
  }

  const correctIds = data.options.filter((o) => o.isCorrect).map((o) => o.id)
  const allCorrectSelected = correctIds.every((id) => selectedIds.has(id))
  const noIncorrectSelected = [...selectedIds].every((id) => correctIds.includes(id))

  return allCorrectSelected && noIncorrectSelected
}

/** Maps an option index to its display letter (0 → "A", 1 → "B", ...). */
export const optionLetter = (index: number): string => String.fromCharCode(65 + index)

/**
 * Whether a message is the hidden user turn that carries an ask widget's
 * answers to the model. The transcript does not render it: the card is the
 * visible record, and the user should not see their answers as typed text.
 */
export const isAskAnswersMessage = (message: Pick<ThunderboltUIMessage, 'role' | 'metadata'>): boolean =>
  message.role === 'user' && message.metadata?.askAnswers === true

/** Namespace prefix for ask entries stored in a message's cache blob. */
export const askCachePrefix = 'ask'

/**
 * Stable djb2 hash of an ask's discriminating shape (`mode` + `options`),
 * base36-encoded. Deterministic across reloads since it's derived only from the
 * parsed widget args, so the restored cache key always matches. It hashes the
 * mode the model wrote, so showing a keyless graded ask as ungraded keeps its key.
 */
const hashAskShape = (data: { mode: AskMode | 'free'; options: AskOption[]; authoredMode?: AskMode }): string => {
  const input = JSON.stringify({ mode: data.authoredMode ?? data.mode, options: data.options })
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Cache key for a single ask instance within a message. Keyed by prompt **plus**
 * a hash of `mode`+`options` so two widgets that share a prompt but differ in
 * their options don't collide on `ask/<prompt>` and overwrite each other's
 * answer. Byte-identical asks in one message share this key; see
 * {@link askStorageKeys} for per-occurrence keys.
 */
export const askStorageKey = (data: {
  prompt: string
  mode: AskMode | 'free'
  options: AskOption[]
  authoredMode?: AskMode
}): string => `${askCachePrefix}/${data.prompt}#${hashAskShape(data)}`

/**
 * Per-ask cache keys for every ask in a message, in message order. The first
 * occurrence of a key keeps {@link askStorageKey} unchanged, so answers saved
 * before duplicates were handled still restore; each later byte-identical ask
 * gets its occurrence number appended (`~2`, `~3`, …) so it is answered and
 * stored on its own.
 */
export const askStorageKeys = (asks: AskData[]): string[] => {
  const baseKeys = asks.map(askStorageKey)
  return baseKeys.map((baseKey, index) => {
    const occurrence = baseKeys.slice(0, index).filter((earlier) => earlier === baseKey).length + 1
    return occurrence === 1 ? baseKey : `${baseKey}~${occurrence}`
  })
}

/**
 * Persisted record of how the user responded to one ask. Stored under
 * {@link askStorageKey} in the message's `cache` column, and read back both
 * to restore the widget UI and to report the response to the model on later turns.
 */
export type AskCacheEntry = {
  prompt: string
  /** `'free'` appears only in entries persisted before the mode was removed. */
  mode: AskMode | 'free'
  /** The option ids the user chose — used to restore the widget UI. */
  selectedIds: string[]
  /** The option texts the user chose — used to report the response to the model. */
  chosen: string[]
  /** Whether the selection matched the designated answer; `null` for ungraded modes (`choice` / `choices`). */
  matched: boolean | null
  /** The typed answer of a legacy `free` entry — still reported to the model. */
  text?: string
  /** The user picked "Other…" and types the rest of the answer in their own message; `chosen` holds only real options. */
  other?: true
  /** The user skipped this optional question; `selectedIds` and `chosen` are empty. */
  skipped?: true
}

const isAskCacheEntry = (value: unknown): value is AskCacheEntry =>
  typeof value === 'object' &&
  value !== null &&
  'prompt' in value &&
  'chosen' in value &&
  Array.isArray((value as AskCacheEntry).chosen)

/** Pulls ask response records out of a message's flat cache blob. */
export const collectAskEntriesFromCache = (cache: Record<string, unknown>): AskCacheEntry[] =>
  Object.entries(cache)
    .filter(([key]) => key.startsWith(`${askCachePrefix}/`))
    .map(([, value]) => value)
    .filter(isAskCacheEntry)

/** The asks of one assistant message, each paired with its saved answer, if any. */
export type AskMessageState = {
  /** Every ask in the message, in order. */
  questions: { ask: AskData; entry?: AskCacheEntry }[]
  /** Answers to legacy `free` asks, which are not in `questions` (they no longer render as asks). */
  legacy: AskCacheEntry[]
}

/**
 * Pairs a message's asks (in message order, see `collectMessageAsks`) with the
 * answers saved in its cache, by the same keys the widget saved them under.
 */
export const askMessageStateOf = (asks: AskData[], cache: Record<string, unknown>): AskMessageState => {
  const keys = askStorageKeys(asks)
  return {
    questions: asks.map((ask, index) => {
      const entry = cache[keys[index]]
      return isAskCacheEntry(entry) ? { ask, entry } : { ask }
    }),
    legacy: collectAskEntriesFromCache(cache).filter((entry) => entry.mode === 'free'),
  }
}

const quoted = (texts: string[]): string => texts.map((text) => `"${text}"`).join(', ')

/** One question's state, in the model-facing note. */
const questionState = (ask: AskData, entry: AskCacheEntry | undefined): string => {
  if (!entry) {
    return 'not answered yet'
  }
  if (entry.skipped) {
    return 'skipped'
  }
  const chosen = quoted(entry.chosen)
  if (entry.other) {
    return chosen
      ? `chose ${chosen} and answered the rest in their own words in their reply`
      : 'answered in their own words in their reply'
  }
  const verdict = isGradedMode(ask.mode)
    ? entry.matched
      ? ' (matches the designated answer)'
      : ' (does not match the designated answer)'
    : ''
  return `answered ${chosen || '(no response)'}${verdict}`
}

const legacyState = (entry: AskCacheEntry): string =>
  entry.text && entry.text.length > 0 ? `answered "${entry.text}"` : 'answered (no response)'

/**
 * The state of every interactive question in the conversation, as a system
 * note for the model: one set per assistant message that asked any, in order,
 * listing each question with its answer, a skip, an answer the user typed in
 * their reply, or that it is still unanswered (so the model knows where a quiz
 * stands mid-way), plus whether a graded answer matched. Returns `null` when no
 * message asked anything.
 */
export const formatAskResponsesNote = (messages: AskMessageState[]): string | null => {
  const sets = messages.filter(({ questions, legacy }) => questions.length > 0 || legacy.length > 0)
  if (sets.length === 0) {
    return null
  }

  const blocks = sets.map(({ questions, legacy }, index) =>
    [
      `Set ${index + 1}:`,
      ...questions.map(({ ask, entry }, number) => `${number + 1}. "${ask.prompt}" — ${questionState(ask, entry)}`),
      ...legacy.map((entry) => `- "${entry.prompt}" — ${legacyState(entry)}`),
    ].join('\n'),
  )

  return [
    '## Interactive questions',
    'The current state of every interactive question (ask widget) in this conversation: one set per assistant message that asked them, in conversation order. It is authoritative: rely on it over the transcript, and never ask the user to re-enter an answer listed here.',
    ...blocks,
  ].join('\n\n')
}

const joinChosen = (chosen: string[]): string =>
  chosen
    .map((c) => c.trim())
    .filter(Boolean)
    .join(', ')

/**
 * One answer per ask, as the user turn words it: a single ask is just its
 * answer; several asks are one numbered `prompt — answer` line each, in message
 * order, so the model can match each answer to its prompt. Blank answers are
 * dropped unless `keep` says otherwise.
 */
const formatAnswers = (
  entries: AskCacheEntry[],
  answerOf: (entry: AskCacheEntry) => string,
  keep: (entry: AskCacheEntry) => boolean = () => false,
): string => {
  if (entries.length === 1) {
    return answerOf(entries[0])
  }
  return entries
    .map((entry) => ({ entry, answer: answerOf(entry) }))
    .filter(({ entry, answer }) => answer || keep(entry))
    .map(({ entry, answer }, index) => `${index + 1}. ${entry.prompt} — ${answer}`)
    .join('\n')
}

/**
 * The text of the hidden answer turn sent once every ask in a message is
 * answered, or `null` when there is nothing to send. A skipped ask keeps its
 * line, answered "skipped", so the numbers always follow the questions. The
 * turn is model-facing (never rendered), so the word stays English.
 */
export const turnTextForAnswers = (entries: AskCacheEntry[]): string | null =>
  formatAnswers(entries, (entry) => (entry.skipped ? 'skipped' : joinChosen(entry.chosen))) || null

/** Whether any answer is an "Other…" the user still has to type. */
export const hasOtherAnswer = (entries: AskCacheEntry[]): boolean => entries.some((entry) => entry.other)

/**
 * The composer draft that replaces the answer turn when an answer is "Other…":
 * the same lines as {@link turnTextForAnswers}, with each "Other…" answer left
 * open (after any options chosen with it) for the user to finish.
 */
export const composerDraftForAnswers = (entries: AskCacheEntry[], skippedText: string): string => {
  const answerOf = (entry: AskCacheEntry): string => {
    if (entry.skipped) {
      return skippedText
    }
    const chosen = joinChosen(entry.chosen)
    return entry.other && chosen ? `${chosen}, ` : chosen
  }
  return formatAnswers(entries, answerOf, (entry) => entry.other === true)
}

/**
 * The step an ask sequence opens on: the first one without a saved answer, or
 * the last one when every step is answered.
 */
export const initialAskStep = (answered: boolean[]): number => {
  const firstUnanswered = answered.indexOf(false)
  return firstUnanswered === -1 ? answered.length - 1 : firstUnanswered
}
