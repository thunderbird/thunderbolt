/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Quiz widget interaction modes:
 * - `single`   — exactly one correct answer (graded, radio-style)
 * - `multiple` — one or more correct answers (graded, checkbox-style)
 * - `choice`   — no correct answer, an open prompt like "What do you want to do next?"
 */
export type QuizMode = 'single' | 'multiple' | 'choice'

export type QuizOption = {
  id: string
  text: string
  /** Only meaningful for `single` / `multiple` modes. Ignored for `choice`. */
  isCorrect?: boolean
}

export type QuizData = {
  /** The question or prompt shown above the options. */
  prompt: string
  mode: QuizMode
  options: QuizOption[]
  /** Optional context shown after the quiz is answered (graded modes only). */
  explanation?: string
}

/**
 * Grades a set of selected option ids against the quiz answer key.
 * Returns `null` for `choice` mode (nothing to grade).
 */
export const gradeQuiz = (data: QuizData, selectedIds: Set<string>): boolean | null => {
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

/** Namespace prefix for quiz entries stored in a message's cache blob. */
export const QUIZ_CACHE_PREFIX = 'quiz'

/** Cache key for a single quiz instance within a message (one tag = one prompt). */
export const quizStorageKey = (prompt: string): string => `${QUIZ_CACHE_PREFIX}/${prompt}`

/**
 * Persisted record of how the user answered one quiz. Stored under
 * {@link quizStorageKey} in the message's `cache` column, and read back both
 * to restore the widget UI and to report results to the model on later turns.
 */
export type QuizCacheEntry = {
  prompt: string
  mode: QuizMode
  /** The option ids the user chose — used to restore the widget UI. */
  selectedIds: string[]
  /** The option texts the user chose — used to report results to the model. */
  chosen: string[]
  /** `true`/`false` for graded modes, `null` for `choice` mode. */
  correct: boolean | null
}

const isQuizCacheEntry = (value: unknown): value is QuizCacheEntry =>
  typeof value === 'object' &&
  value !== null &&
  'prompt' in value &&
  'chosen' in value &&
  Array.isArray((value as QuizCacheEntry).chosen)

/** Pulls quiz answer records out of a message's flat cache blob. */
export const collectQuizEntriesFromCache = (cache: Record<string, unknown>): QuizCacheEntry[] =>
  Object.entries(cache)
    .filter(([key]) => key.startsWith(`${QUIZ_CACHE_PREFIX}/`))
    .map(([, value]) => value)
    .filter(isQuizCacheEntry)

/**
 * Renders the user's quiz answers as a system note for the model, so it can
 * answer "what did I score?" without asking the user to re-enter their choices.
 * Returns `null` when there are no answered quizzes.
 */
export const formatQuizResultsNote = (entries: QuizCacheEntry[]): string | null => {
  if (entries.length === 0) {
    return null
  }

  const lines = entries.map((entry) => {
    const chosen = entry.chosen.length > 0 ? entry.chosen.map((c) => `"${c}"`).join(', ') : '(no answer)'
    if (entry.correct === null) {
      return `- "${entry.prompt}" — chose ${chosen}`
    }
    return `- "${entry.prompt}" — chose ${chosen} — ${entry.correct ? 'correct' : 'incorrect'}`
  })

  const graded = entries.filter((e) => e.correct !== null)
  const score =
    graded.length > 0
      ? `\nScore: ${graded.filter((e) => e.correct).length}/${graded.length} (${Math.round(
          (graded.filter((e) => e.correct).length / graded.length) * 100,
        )}%).`
      : ''

  return [
    '## Quiz results',
    'The user answered quiz widgets in this conversation. Use these results if they ask about their answers or score — do not ask them to re-enter their choices.',
    ...lines,
    score,
  ]
    .join('\n')
    .trim()
}
