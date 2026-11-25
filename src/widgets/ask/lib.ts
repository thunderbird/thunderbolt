/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

/**
 * Renders the user's responses as a system note for the model, so it can refer
 * back to what the user chose or wrote without asking them to re-enter it.
 * Returns `null` when there are no responses.
 */
export const formatAskResponsesNote = (entries: AskCacheEntry[]): string | null => {
  if (entries.length === 0) {
    return null
  }

  const lines = entries.map((entry) => {
    if (entry.mode === 'free') {
      const answer = entry.text && entry.text.length > 0 ? `"${entry.text}"` : '(no response)'
      return `- "${entry.prompt}" — answered ${answer}`
    }
    if (entry.skipped) {
      return `- "${entry.prompt}" — skipped`
    }
    const chosen = entry.chosen.map((c) => `"${c}"`).join(', ')
    if (entry.other) {
      const prefix = chosen ? `chose ${chosen} and ` : ''
      return `- "${entry.prompt}" — ${prefix}answered in their own words in their reply`
    }
    return `- "${entry.prompt}" — chose ${chosen || '(no response)'}`
  })

  return [
    '## User responses',
    'The user responded to interactive prompts in this conversation. Use these if they refer back to their responses — do not ask them to re-enter their choices.',
    ...lines,
  ].join('\n')
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
 * The user-turn text sent once every ask in a message is answered, or `null`
 * when there is nothing to send. A skipped ask keeps its line, answered with
 * `skippedText` (localized by the caller, since it shows in the user's bubble),
 * so the numbers always follow the questions.
 */
export const turnTextForAnswers = (entries: AskCacheEntry[], skippedText: string): string | null =>
  formatAnswers(entries, (entry) => (entry.skipped ? skippedText : joinChosen(entry.chosen))) || null

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
