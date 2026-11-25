/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  askStorageKey,
  collectAskEntriesFromCache,
  composerDraftForAnswers,
  evaluateAnswer,
  hasOtherAnswer,
  formatAskResponsesNote,
  isGradedMode,
  isMultiSelectMode,
  optionLetter,
  initialAskStep,
  askStorageKeys,
  turnTextForAnswers,
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

  test('choices: no designated answer even with several selected', () => {
    expect(evaluateAnswer({ ...multiAsk, mode: 'choices' }, new Set(['a', 'b']))).toBeNull()
  })
})

describe('mode helpers', () => {
  test('isGradedMode: only single/multiple are graded', () => {
    expect(isGradedMode('single')).toBe(true)
    expect(isGradedMode('multiple')).toBe(true)
    expect(isGradedMode('choice')).toBe(false)
    expect(isGradedMode('choices')).toBe(false)
  })

  test('isMultiSelectMode: multiple and choices allow several selections', () => {
    expect(isMultiSelectMode('multiple')).toBe(true)
    expect(isMultiSelectMode('choices')).toBe(true)
    expect(isMultiSelectMode('single')).toBe(false)
    expect(isMultiSelectMode('choice')).toBe(false)
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

  test('reports a multi-select (choices) response with every pick', () => {
    const note = formatAskResponsesNote([
      {
        prompt: 'Which do you like?',
        mode: 'choices',
        selectedIds: ['a', 'b'],
        chosen: ['Coffee', 'Tea'],
        matched: null,
      },
    ])
    expect(note).toContain('"Which do you like?" — chose "Coffee", "Tea"')
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

const entry = (prompt: string, mode: AskCacheEntry['mode'], chosen: string[]): AskCacheEntry => ({
  prompt,
  mode,
  selectedIds: chosen,
  chosen,
  matched: null,
})

describe('turnTextForAnswers', () => {
  test('a lone ask sends its chosen option text(s), comma-joined, in any mode', () => {
    expect(turnTextForAnswers([entry('What next?', 'choice', ['Draft a reply'])], 'skipped')).toBe('Draft a reply')
    expect(turnTextForAnswers([entry('Like?', 'choices', ['Coffee', 'Tea'])], 'skipped')).toBe('Coffee, Tea')
    expect(turnTextForAnswers([entry('Capital?', 'single', ['Paris'])], 'skipped')).toBe('Paris')
  })

  test('a sequence sends one numbered line per question', () => {
    expect(
      turnTextForAnswers(
        [
          entry('Which sends mail?', 'single', ['SMTP']),
          entry('Pick the standards', 'multiple', ['OpenPGP', 'S/MIME']),
        ],
        'skipped',
      ),
    ).toBe('1. Which sends mail? — SMTP\n2. Pick the standards — OpenPGP, S/MIME')
  })

  test('empty / whitespace-only answers send nothing', () => {
    expect(turnTextForAnswers([entry('What next?', 'choice', [])], 'skipped')).toBeNull()
    expect(turnTextForAnswers([entry('What next?', 'choice', ['   '])], 'skipped')).toBeNull()
    expect(turnTextForAnswers([entry('A?', 'single', []), entry('B?', 'single', [' '])], 'skipped')).toBeNull()
  })
})

const skipped = (prompt: string): AskCacheEntry => ({ ...entry(prompt, 'choice', []), skipped: true })
const other = (prompt: string, chosen: string[] = []): AskCacheEntry => ({
  ...entry(prompt, 'choices', chosen),
  other: true,
})

describe('turnTextForAnswers with skipped asks', () => {
  test('a skipped ask keeps its line and number, answered with the given word', () => {
    expect(
      turnTextForAnswers(
        [entry('A?', 'choice', ['Yes']), skipped('B?'), entry('C?', 'choice', ['No'])],
        'übersprungen',
      ),
    ).toBe('1. A? — Yes\n2. B? — übersprungen\n3. C? — No')
  })

  test('a skipped last ask still gets its line', () => {
    expect(turnTextForAnswers([entry('A?', 'choice', ['Yes']), skipped('B?')], 'skipped')).toBe(
      '1. A? — Yes\n2. B? — skipped',
    )
  })

  test('skipping every ask still sends, so the model hears the user declined', () => {
    expect(turnTextForAnswers([skipped('A?'), skipped('B?')], 'skipped')).toBe('1. A? — skipped\n2. B? — skipped')
  })
})

describe('composerDraftForAnswers', () => {
  test('a lone "Other…" leaves the composer empty for the user to type', () => {
    expect(composerDraftForAnswers([other('What next?')], 'skipped')).toBe('')
  })

  test('a lone "Other…" with options picked lists them, open for more', () => {
    expect(composerDraftForAnswers([other('Like?', ['Coffee', 'Tea'])], 'skipped')).toBe('Coffee, Tea, ')
  })

  test('several asks keep every numbered line, with "Other…" lines left open', () => {
    expect(
      composerDraftForAnswers(
        [entry('A?', 'choice', ['Yes']), other('B?'), skipped('C?'), other('D?', ['Tea'])],
        'skipped',
      ),
    ).toBe('1. A? — Yes\n2. B? — \n3. C? — skipped\n4. D? — Tea, ')
  })

  test('hasOtherAnswer spots an "Other…" answer', () => {
    expect(hasOtherAnswer([entry('A?', 'choice', ['Yes']), other('B?')])).toBe(true)
    expect(hasOtherAnswer([entry('A?', 'choice', ['Yes']), skipped('B?')])).toBe(false)
  })
})

describe('formatAskResponsesNote with skipped and "Other…" answers', () => {
  test('reports a skip and an answer the user typed in their reply', () => {
    const note = formatAskResponsesNote([skipped('A?'), other('B?'), other('C?', ['Tea'])])
    expect(note).toContain('"A?" — skipped')
    expect(note).toContain('"B?" — answered in their own words in their reply')
    expect(note).toContain('"C?" — chose "Tea" and answered in their own words in their reply')
  })
})

describe('initialAskStep', () => {
  test('opens on the first unanswered step', () => {
    expect(initialAskStep([false, false])).toBe(0)
    expect(initialAskStep([true, false, false])).toBe(1)
  })

  test('opens on the last step once every step is answered', () => {
    expect(initialAskStep([true, true, true])).toBe(2)
  })
})

describe('askStorageKeys', () => {
  const choice = (prompt: string): AskData => ({ prompt, mode: 'choice', options: [{ id: 'a', text: 'A' }] })

  test('distinct asks keep their askStorageKey, so saved answers still restore', () => {
    const asks = [choice('One?'), choice('Two?')]
    expect(askStorageKeys(asks)).toEqual(asks.map(askStorageKey))
  })

  test('a repeated identical ask gets its occurrence number appended', () => {
    const base = askStorageKey(choice('Again?'))
    expect(askStorageKeys([choice('Again?'), choice('Other?'), choice('Again?'), choice('Again?')])).toEqual([
      base,
      askStorageKey(choice('Other?')),
      `${base}~2`,
      `${base}~3`,
    ])
  })

  test('suffixed keys are still collected as ask entries', () => {
    const key = askStorageKeys([choice('Again?'), choice('Again?')])[1]
    expect(collectAskEntriesFromCache({ [key]: entry('Again?', 'choice', ['A']) })).toHaveLength(1)
  })
})
