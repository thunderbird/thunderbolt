/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  askStorageKey,
  collectAskEntriesFromCache,
  evaluateAnswer,
  formatAskResponsesNote,
  optionLetter,
  turnTextForAnswer,
  type AskCacheEntry,
  type AskData,
} from './lib'

const singleAsk: AskData = {
  prompt: 'Capital of France?',
  mode: 'single',
  options: [
    { id: 'a', text: 'Paris', isCorrect: true },
    { id: 'b', text: 'Lyon' },
  ],
}

const multiAsk: AskData = {
  prompt: 'Pick the encryption standards',
  mode: 'multiple',
  options: [
    { id: 'a', text: 'OpenPGP', isCorrect: true },
    { id: 'b', text: 'S/MIME', isCorrect: true },
    { id: 'c', text: 'Base64' },
  ],
}

describe('evaluateAnswer', () => {
  test('single: matches only when the designated option is chosen', () => {
    expect(evaluateAnswer(singleAsk, new Set(['a']))).toBe(true)
    expect(evaluateAnswer(singleAsk, new Set(['b']))).toBe(false)
  })

  test('multiple: all-or-nothing', () => {
    expect(evaluateAnswer(multiAsk, new Set(['a', 'b']))).toBe(true)
    expect(evaluateAnswer(multiAsk, new Set(['a']))).toBe(false) // missing one
    expect(evaluateAnswer(multiAsk, new Set(['a', 'b', 'c']))).toBe(false) // extra wrong
  })

  test('choice: no designated answer', () => {
    expect(evaluateAnswer({ ...singleAsk, mode: 'choice' }, new Set(['a']))).toBeNull()
  })
})

describe('optionLetter', () => {
  test('maps index to letter', () => {
    expect(optionLetter(0)).toBe('A')
    expect(optionLetter(2)).toBe('C')
  })
})

describe('askStorageKey', () => {
  const base: Pick<AskData, 'prompt' | 'mode' | 'options'> = {
    prompt: 'Pick one',
    mode: 'single',
    options: [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B' },
    ],
  }

  test('is namespaced and deterministic for identical shapes', () => {
    expect(askStorageKey(base)).toStartWith('ask/Pick one#')
    expect(askStorageKey(base)).toBe(askStorageKey({ ...base, options: [...base.options] }))
  })

  test('same prompt but different options yields a different key (no collision)', () => {
    const other = {
      ...base,
      options: [
        { id: 'a', text: 'A' },
        { id: 'c', text: 'C', isCorrect: true },
      ],
    }
    expect(askStorageKey(other)).not.toBe(askStorageKey(base))
  })

  test('same prompt but different mode yields a different key', () => {
    expect(askStorageKey({ ...base, mode: 'multiple' })).not.toBe(askStorageKey(base))
  })
})

describe('collectAskEntriesFromCache', () => {
  test('pulls only ask-namespaced entries', () => {
    const entry: AskCacheEntry = {
      prompt: 'Capital of France?',
      mode: 'single',
      selectedIds: ['b'],
      chosen: ['Lyon'],
      matched: false,
    }
    const cache = {
      'ask/Capital of France?': entry,
      'linkPreview/https://x.com': { title: 'x' },
      'weatherForecast/Seattle': { days: [] },
    }
    expect(collectAskEntriesFromCache(cache)).toEqual([entry])
  })

  test('ignores malformed entries', () => {
    expect(collectAskEntriesFromCache({ 'ask/bad': { prompt: 'x' } })).toEqual([])
  })
})

describe('formatAskResponsesNote', () => {
  test('returns null with no entries', () => {
    expect(formatAskResponsesNote([])).toBeNull()
  })

  test('reports option selections without a score or verdict', () => {
    const note = formatAskResponsesNote([
      { prompt: 'Q1', mode: 'single', selectedIds: ['a'], chosen: ['Paris'], matched: true },
      { prompt: 'Q2', mode: 'single', selectedIds: ['b'], chosen: ['Thames'], matched: false },
    ])
    expect(note).toContain('"Q1" — chose "Paris"')
    expect(note).toContain('"Q2" — chose "Thames"')
    expect(note).not.toContain('correct')
    expect(note).not.toContain('incorrect')
    expect(note).not.toContain('Score:')
  })

  test('reports a choice selection', () => {
    const note = formatAskResponsesNote([
      { prompt: 'What next?', mode: 'choice', selectedIds: ['draft'], chosen: ['Draft a reply'], matched: null },
    ])
    expect(note).toContain('"What next?" — chose "Draft a reply"')
  })

  test('reports legacy free-text answers verbatim', () => {
    const note = formatAskResponsesNote([
      {
        prompt: 'Define photosynthesis',
        mode: 'free',
        selectedIds: [],
        chosen: ['Plants making food from light'],
        matched: null,
        text: 'Plants making food from light',
      },
    ])
    expect(note).toContain('"Define photosynthesis" — answered "Plants making food from light"')
  })

  test('legacy free-text with no answer shows (no response)', () => {
    const note = formatAskResponsesNote([
      { prompt: 'Define X', mode: 'free', selectedIds: [], chosen: [], matched: null },
    ])
    expect(note).toContain('"Define X" — answered (no response)')
  })
})

describe('turnTextForAnswer', () => {
  test('choice dispatches the chosen option text', () => {
    expect(turnTextForAnswer('choice', ['Draft a reply'])).toBe('Draft a reply')
  })

  test('graded modes never dispatch a turn (no quiz loop)', () => {
    expect(turnTextForAnswer('single', ['Paris'])).toBeNull()
    expect(turnTextForAnswer('multiple', ['OpenPGP', 'S/MIME'])).toBeNull()
  })

  test('empty / whitespace-only answers dispatch nothing', () => {
    expect(turnTextForAnswer('choice', [])).toBeNull()
    expect(turnTextForAnswer('choice', ['   '])).toBeNull()
  })
})
