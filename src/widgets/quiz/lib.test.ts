/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  collectQuizEntriesFromCache,
  formatQuizResultsNote,
  gradeQuiz,
  optionLetter,
  type QuizCacheEntry,
  type QuizData,
} from './lib'

const singleQuiz: QuizData = {
  prompt: 'Capital of France?',
  mode: 'single',
  options: [
    { id: 'a', text: 'Paris', isCorrect: true },
    { id: 'b', text: 'Lyon' },
  ],
}

const multiQuiz: QuizData = {
  prompt: 'Pick the encryption standards',
  mode: 'multiple',
  options: [
    { id: 'a', text: 'OpenPGP', isCorrect: true },
    { id: 'b', text: 'S/MIME', isCorrect: true },
    { id: 'c', text: 'Base64' },
  ],
}

describe('gradeQuiz', () => {
  test('single: correct only when the right option is chosen', () => {
    expect(gradeQuiz(singleQuiz, new Set(['a']))).toBe(true)
    expect(gradeQuiz(singleQuiz, new Set(['b']))).toBe(false)
  })

  test('multiple: all-or-nothing', () => {
    expect(gradeQuiz(multiQuiz, new Set(['a', 'b']))).toBe(true)
    expect(gradeQuiz(multiQuiz, new Set(['a']))).toBe(false) // missing one
    expect(gradeQuiz(multiQuiz, new Set(['a', 'b', 'c']))).toBe(false) // extra wrong
  })

  test('choice: nothing to grade', () => {
    expect(gradeQuiz({ ...singleQuiz, mode: 'choice' }, new Set(['a']))).toBeNull()
  })
})

describe('optionLetter', () => {
  test('maps index to letter', () => {
    expect(optionLetter(0)).toBe('A')
    expect(optionLetter(2)).toBe('C')
  })
})

describe('collectQuizEntriesFromCache', () => {
  test('pulls only quiz-namespaced entries', () => {
    const entry: QuizCacheEntry = {
      prompt: 'Capital of France?',
      mode: 'single',
      selectedIds: ['b'],
      chosen: ['Lyon'],
      correct: false,
    }
    const cache = {
      'quiz/Capital of France?': entry,
      'linkPreview/https://x.com': { title: 'x' },
      'weatherForecast/Seattle': { days: [] },
    }
    expect(collectQuizEntriesFromCache(cache)).toEqual([entry])
  })

  test('ignores malformed entries', () => {
    expect(collectQuizEntriesFromCache({ 'quiz/bad': { prompt: 'x' } })).toEqual([])
  })
})

describe('formatQuizResultsNote', () => {
  test('returns null with no entries', () => {
    expect(formatQuizResultsNote([])).toBeNull()
  })

  test('summarizes graded answers with a score', () => {
    const note = formatQuizResultsNote([
      { prompt: 'Q1', mode: 'single', selectedIds: ['a'], chosen: ['Paris'], correct: true },
      { prompt: 'Q2', mode: 'single', selectedIds: ['b'], chosen: ['Thames'], correct: false },
    ])
    expect(note).toContain('"Q1" — chose "Paris" — correct')
    expect(note).toContain('"Q2" — chose "Thames" — incorrect')
    expect(note).toContain('Score: 1/2 (50%).')
  })

  test('omits score for ungraded choice answers', () => {
    const note = formatQuizResultsNote([
      { prompt: 'What next?', mode: 'choice', selectedIds: ['draft'], chosen: ['Draft a reply'], correct: null },
    ])
    expect(note).toContain('"What next?" — chose "Draft a reply"')
    expect(note).not.toContain('Score:')
  })
})
