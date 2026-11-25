/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ContentPart } from '@/ai/widget-parser'
import type { Widget } from '@/ai/widget-types'
import { describe, expect, test } from 'bun:test'
import { askDataOf, groupAskSequences, messageAsksOf } from './group'
import { askStorageKey } from './lib'

const options = [
  { id: 'a', text: 'A', isCorrect: true },
  { id: 'b', text: 'B' },
]

const ask = (prompt: string, mode = 'single'): ContentPart => ({
  type: 'widget',
  widget: { widget: 'ask', args: { prompt, mode, options } } as Widget,
})

const text = (content: string): ContentPart => ({ type: 'text', content })

describe('groupAskSequences', () => {
  test('wraps a lone ask in a one-step sequence', () => {
    expect(groupAskSequences([text('Intro'), ask('Q1')])).toEqual([
      text('Intro'),
      { type: 'ask-sequence', asks: [{ prompt: 'Q1', mode: 'single', options, explanation: undefined }], offset: 0 },
    ])
  })

  test('merges asks separated only by whitespace, keeping surrounding text', () => {
    const grouped = groupAskSequences([
      text('Quiz time'),
      ask('Q1'),
      text('\n\n'),
      ask('Q2'),
      ask('Q3'),
      text('Good luck!'),
    ])

    expect(grouped).toHaveLength(3)
    expect(grouped[0]).toEqual(text('Quiz time'))
    expect(grouped[1]).toMatchObject({
      type: 'ask-sequence',
      asks: [{ prompt: 'Q1' }, { prompt: 'Q2' }, { prompt: 'Q3' }],
    })
    expect(grouped[2]).toEqual(text('Good luck!'))
  })

  test('real text between asks starts a new sequence', () => {
    const grouped = groupAskSequences([ask('Q1'), text('Now a harder one:'), ask('Q2')])

    expect(grouped.map((part) => part.type)).toEqual(['ask-sequence', 'text', 'ask-sequence'])
  })

  test('each sequence records where its first ask sits among the message asks', () => {
    const grouped = groupAskSequences([ask('Q1'), ask('Q2'), text('Next:'), ask('Q3'), text('And:'), ask('Q4')])

    expect(grouped.flatMap((part) => (part.type === 'ask-sequence' ? [part.offset] : []))).toEqual([0, 2, 3])
    expect(messageAsksOf(grouped).map((data) => data.prompt)).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
  })

  test('keeps trailing whitespace after the last ask', () => {
    expect(groupAskSequences([ask('Q1'), text('\n')]).at(-1)).toEqual(text('\n'))
  })

  test('leaves legacy free asks and other widgets alone', () => {
    const free = ask('Tell me', 'free')
    const map: ContentPart = { type: 'widget', widget: { widget: 'map', args: {} } as Widget }

    expect(groupAskSequences([free, map])).toEqual([free, map])
  })

  test('absorbs an ask still streaming in after a sequence', () => {
    const grouped = groupAskSequences([ask('Q1'), text('\n'), { type: 'widget-loading', name: 'ask' }])

    expect(grouped).toEqual([{ type: 'ask-sequence', asks: [expect.objectContaining({ prompt: 'Q1' })], offset: 0 }])
  })
})

describe('optional asks', () => {
  const optionalAsk = (prompt: string, optional: string): ContentPart => ({
    type: 'widget',
    widget: { widget: 'ask', args: { prompt, mode: 'choice', options, optional } } as Widget,
  })

  test('only optional="true" makes an ask skippable', () => {
    const asks = messageAsksOf(groupAskSequences([optionalAsk('Q1', 'true'), optionalAsk('Q2', 'yes'), ask('Q3')]))
    expect(asks.map((a) => a.optional)).toEqual([true, undefined, undefined])
  })
})

describe('askDataOf: a graded ask without an answer key', () => {
  const keyless = [
    { id: 'a', text: 'yama' },
    { id: 'b', text: 'kawa' },
  ]

  test('shows a keyless single as choice and a keyless multiple as choices, keeping the authored mode', () => {
    expect(askDataOf({ prompt: 'Mountain?', mode: 'single', options: keyless })).toMatchObject({
      mode: 'choice',
      authoredMode: 'single',
    })
    expect(askDataOf({ prompt: 'Mountains?', mode: 'multiple', options: keyless })).toMatchObject({
      mode: 'choices',
      authoredMode: 'multiple',
    })
  })

  test('leaves an ask alone once any option is marked correct, and never touches ungraded modes', () => {
    const graded = askDataOf({ prompt: 'Mountain?', mode: 'single', options })
    expect(graded?.mode).toBe('single')
    expect(graded).not.toHaveProperty('authoredMode')
    expect(askDataOf({ prompt: 'Next?', mode: 'choice', options: keyless })).not.toHaveProperty('authoredMode')
  })

  test('keeps the storage key the authored mode gave it, so answers saved before still restore', () => {
    const shown = askDataOf({ prompt: 'Mountain?', mode: 'single', options: keyless })
    expect(shown && askStorageKey(shown)).toBe(askStorageKey({ prompt: 'Mountain?', mode: 'single', options: keyless }))
  })
})
