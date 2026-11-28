/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  askStorageKey,
  askMessageStateOf,
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

const entry = (prompt: string, mode: AskCacheEntry['mode'], chosen: string[]): AskCacheEntry => ({
  prompt,
  mode,
  selectedIds: chosen,
  chosen,
  matched: null,
})

describe('turnTextForAnswers', () => {
  test('a lone ask sends its chosen option text(s), comma-joined, in any mode', () => {
    expect(turnTextForAnswers([entry('What next?', 'choice', ['Draft a reply'])])).toBe('Draft a reply')
    expect(turnTextForAnswers([entry('Like?', 'choices', ['Coffee', 'Tea'])])).toBe('Coffee, Tea')
    expect(turnTextForAnswers([entry('Capital?', 'single', ['Paris'])])).toBe('Paris')
  })

  test('a sequence sends one numbered line per question', () => {
    expect(
      turnTextForAnswers([
        entry('Which sends mail?', 'single', ['SMTP']),
        entry('Pick the standards', 'multiple', ['OpenPGP', 'S/MIME']),
      ]),
    ).toBe('1. Which sends mail? — SMTP\n2. Pick the standards — OpenPGP, S/MIME')
  })

  test('empty / whitespace-only answers send nothing', () => {
    expect(turnTextForAnswers([entry('What next?', 'choice', [])])).toBeNull()
    expect(turnTextForAnswers([entry('What next?', 'choice', ['   '])])).toBeNull()
    expect(turnTextForAnswers([entry('A?', 'single', []), entry('B?', 'single', [' '])])).toBeNull()
  })
})

const skipped = (prompt: string): AskCacheEntry => ({ ...entry(prompt, 'choice', []), skipped: true })
const other = (prompt: string, chosen: string[] = []): AskCacheEntry => ({
  ...entry(prompt, 'choices', chosen),
  other: true,
})

describe('turnTextForAnswers with skipped asks', () => {
  test('a skipped ask keeps its line and number, answered "skipped" in English (the turn is model-facing)', () => {
    expect(turnTextForAnswers([entry('A?', 'choice', ['Yes']), skipped('B?'), entry('C?', 'choice', ['No'])])).toBe(
      '1. A? — Yes\n2. B? — skipped\n3. C? — No',
    )
  })

  test('a skipped last ask still gets its line', () => {
    expect(turnTextForAnswers([entry('A?', 'choice', ['Yes']), skipped('B?')])).toBe('1. A? — Yes\n2. B? — skipped')
  })

  test('skipping every ask still sends, so the model hears the user declined', () => {
    expect(turnTextForAnswers([skipped('A?'), skipped('B?')])).toBe('1. A? — skipped\n2. B? — skipped')
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
        'übersprungen',
      ),
    ).toBe('1. A? — Yes\n2. B? — \n3. C? — übersprungen\n4. D? — Tea, ')
  })

  test('hasOtherAnswer spots an "Other…" answer', () => {
    expect(hasOtherAnswer([entry('A?', 'choice', ['Yes']), other('B?')])).toBe(true)
    expect(hasOtherAnswer([entry('A?', 'choice', ['Yes']), skipped('B?')])).toBe(false)
  })
})

describe('askMessageStateOf', () => {
  const choice = (prompt: string): AskData => ({ prompt, mode: 'choice', options: [{ id: 'a', text: 'A' }] })

  test('pairs each ask with the answer saved under its key, leaving the rest unanswered', () => {
    const asks = [choice('One?'), choice('Two?'), choice('One?')]
    const keys = askStorageKeys(asks)
    const state = askMessageStateOf(asks, { [keys[2]]: entry('One?', 'choice', ['A']), unrelated: { title: 'x' } })

    expect(state.questions.map(({ ask, entry }) => [ask.prompt, entry?.chosen])).toEqual([
      ['One?', undefined],
      ['Two?', undefined],
      ['One?', ['A']],
    ])
    expect(state.legacy).toEqual([])
  })

  test('keeps legacy free answers, which have no ask to pair with', () => {
    const free: AskCacheEntry = {
      prompt: 'Define X',
      mode: 'free',
      selectedIds: [],
      chosen: [],
      matched: null,
      text: 'Y',
    }
    expect(askMessageStateOf([], { 'ask/Define X#1': free }).legacy).toEqual([free])
  })
})

describe('formatAskResponsesNote', () => {
  const graded = (prompt: string): AskData => ({
    prompt,
    mode: 'single',
    options: [
      { id: 'a', text: 'Paris', isCorrect: true },
      { id: 'b', text: 'Lyon' },
    ],
  })
  const open = (prompt: string): AskData => ({ prompt, mode: 'choices', options: [{ id: 'a', text: 'Tea' }] })

  test('returns null when no message asked anything', () => {
    expect(formatAskResponsesNote([])).toBeNull()
    expect(formatAskResponsesNote([{ questions: [], legacy: [] }])).toBeNull()
  })

  test('lists every question of each asking message, in order, with its state', () => {
    const note = formatAskResponsesNote([
      {
        questions: [
          {
            ask: graded('Capital of France?'),
            entry: { ...entry('Capital of France?', 'single', ['Paris']), matched: true },
          },
          { ask: graded('Second city?'), entry: { ...entry('Second city?', 'single', ['Paris']), matched: false } },
          { ask: open('Drinks?'), entry: skipped('Drinks?') },
          { ask: open('Snacks?'), entry: other('Snacks?') },
          { ask: open('Desserts?'), entry: other('Desserts?', ['Tea']) },
          { ask: open('Music?'), entry: entry('Music?', 'choices', ['Tea']) },
          { ask: open('Last one?') },
        ],
        legacy: [],
      },
      { questions: [], legacy: [] },
      { questions: [{ ask: open('Later?') }], legacy: [] },
    ])

    expect(note).toBe(
      [
        '## Interactive questions',
        'The current state of every interactive question (ask widget) in this conversation: one set per assistant message that asked them, in conversation order. It is authoritative: rely on it over the transcript, and never ask the user to re-enter an answer listed here.',
        [
          'Set 1:',
          '1. "Capital of France?" — answered "Paris" (matches the designated answer)',
          '2. "Second city?" — answered "Paris" (does not match the designated answer)',
          '3. "Drinks?" — skipped',
          '4. "Snacks?" — answered in their own words in their reply',
          '5. "Desserts?" — chose "Tea" and answered the rest in their own words in their reply',
          '6. "Music?" — answered "Tea"',
          '7. "Last one?" — not answered yet',
        ].join('\n'),
        ['Set 2:', '1. "Later?" — not answered yet'].join('\n'),
      ].join('\n\n'),
    )
  })

  test('reports legacy free-text answers verbatim, and a blank one as no response', () => {
    const free = (text?: string): AskCacheEntry => ({
      prompt: 'Define X',
      mode: 'free',
      selectedIds: [],
      chosen: [],
      matched: null,
      ...(text && { text }),
    })
    const note = formatAskResponsesNote([{ questions: [], legacy: [free('Plants making food'), free()] }])
    expect(note).toContain('- "Define X" — answered "Plants making food"')
    expect(note).toContain('- "Define X" — answered (no response)')
  })

  test('surfaces no score or verdict wording beyond the match marker', () => {
    const note =
      formatAskResponsesNote([
        {
          questions: [{ ask: graded('Q?'), entry: { ...entry('Q?', 'single', ['Lyon']), matched: false } }],
          legacy: [],
        },
      ]) ?? ''
    expect(note).not.toMatch(/correct|score/i)
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
