/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Ask widget interaction modes:
 * - `single`   — exactly one designated answer (radio-style)
 * - `multiple` — one or more designated answers (checkbox-style)
 * - `choice`   — no designated answer, an open prompt like "What do you want to do next?"
 *
 * (A `free` text-response mode existed briefly and was removed — typing an
 * answer belongs in the regular composer. Historical `free` widgets still
 * parse and render read-only (see `schema.ts` / `LegacyFreeAsk`), and cached
 * `free` entries still report to the model; see {@link formatAskResponsesNote}.)
 *
 * The array is the single source for the schema's `z.enum`, so the type and
 * the wire validation can't drift.
 */
export const askModes = ['single', 'multiple', 'choice'] as const
export type AskMode = (typeof askModes)[number]

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
}

/**
 * Compares a set of selected option ids against the designated answer(s).
 * Returns `null` for modes without a designated answer (`choice`).
 */
export const evaluateAnswer = (data: AskData, selectedIds: Set<string>): boolean | null => {
  if (data.mode === 'choice') {
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
 * parsed widget args, so the restored cache key always matches.
 */
const hashAskShape = (data: { mode: AskMode | 'free'; options: AskOption[] }): string => {
  const input = JSON.stringify({ mode: data.mode, options: data.options })
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
 * answer. (Two byte-identical widgets still share a key, which is harmless.)
 */
export const askStorageKey = (data: { prompt: string; mode: AskMode | 'free'; options: AskOption[] }): string =>
  `${askCachePrefix}/${data.prompt}#${hashAskShape(data)}`

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
  /** Whether the selection matched the designated answer; `null` for `choice`. */
  matched: boolean | null
  /** The typed answer of a legacy `free` entry — still reported to the model. */
  text?: string
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
    const chosen = entry.chosen.length > 0 ? entry.chosen.map((c) => `"${c}"`).join(', ') : '(no response)'
    return `- "${entry.prompt}" — chose ${chosen}`
  })

  return [
    '## User responses',
    'The user responded to interactive prompts in this conversation. Use these if they refer back to their responses — do not ask them to re-enter their choices.',
    ...lines,
  ].join('\n')
}

/**
 * The user-turn text to dispatch when an ask is submitted, or `null` if none
 * should be sent. `choice` (an action pick) is a conversational response the
 * model should act on, so it produces a turn; graded `single`/`multiple`
 * reveal the answer client-side and produce none (auto-sending them would
 * goad single-prompt backends into endlessly asking the next question).
 * Empty input produces `null`.
 */
export const turnTextForAnswer = (mode: AskMode, chosen: string[]): string | null => {
  if (mode !== 'choice') {
    return null
  }
  const answer = (chosen[0] ?? '').trim()
  return answer || null
}
