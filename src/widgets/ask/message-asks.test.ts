/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { describe, expect, mock, test } from 'bun:test'
import { askStorageKeys, type AskCacheEntry } from './lib'
import { collectConversationAskStates, collectMessageAsks } from './message-asks'

const answered = (prompt: string): AskCacheEntry => ({
  prompt,
  mode: 'single',
  selectedIds: ['a'],
  chosen: ['A'],
  matched: true,
})

const ask = (prompt: string) =>
  `<widget:ask mode="single" prompt="${prompt}" options='[{"id":"a","text":"A","isCorrect":true},{"id":"b","text":"B"}]' />`

describe('collectMessageAsks', () => {
  test('collects asks across text parts, with each part’s starting offset', () => {
    const { asks, offsets } = collectMessageAsks([
      `Quiz time\n${ask('Q1')}\n${ask('Q2')}`,
      'Let me look that up.',
      `${ask('Q3')}\nGood luck!`,
    ])

    expect(asks.map((a) => a.prompt)).toEqual(['Q1', 'Q2', 'Q3'])
    expect(offsets).toEqual([0, 2, 2])
  })

  test('matches tags in any case, like the parser', () => {
    expect(collectMessageAsks([ask('Q1').replace('widget:ask', 'WIDGET:ASK')]).asks.map((a) => a.prompt)).toEqual([
      'Q1',
    ])
  })

  test('a message without asks yields none', () => {
    expect(collectMessageAsks(['Hello', 'World'])).toEqual({ asks: [], offsets: [0, 0] })
  })
})

describe('collectConversationAskStates', () => {
  const message = (id: string, role: 'user' | 'assistant', text: string): ThunderboltUIMessage =>
    ({ id, role, parts: [{ type: 'text', text }] }) as ThunderboltUIMessage

  test('lists open asks from the text and answers from the cache, reading only messages that ask', async () => {
    const readCache = mock(async (id: string) =>
      id === 'quiz'
        ? { [askStorageKeys(collectMessageAsks([`${ask('Q1')}${ask('Q2')}`]).asks)[0]]: answered('Q1') }
        : null,
    )
    const states = await collectConversationAskStates(
      [
        message('user', 'user', ask('Typed by the user')),
        message('plain', 'assistant', 'No questions here'),
        message('quiz', 'assistant', `${ask('Q1')}${ask('Q2')}`),
        message('later', 'assistant', ask('Q3')),
      ],
      readCache,
    )

    expect(readCache.mock.calls.map(([id]) => id)).toEqual(['quiz', 'later'])
    expect(
      states.map(({ questions }) => questions.map(({ ask, entry }) => [ask.prompt, entry?.chosen ?? null])),
    ).toEqual([
      [
        ['Q1', ['A']],
        ['Q2', null],
      ],
      [['Q3', null]],
    ])
  })

  test('reads a message whose tags are uppercase, like the parser', async () => {
    const readCache = mock(async (_id: string) => null)
    const states = await collectConversationAskStates(
      [message('quiz', 'assistant', ask('Q1').replace('widget:ask', 'WIDGET:ASK'))],
      readCache,
    )

    expect(readCache.mock.calls.map(([id]) => id)).toEqual(['quiz'])
    expect(states.map(({ questions }) => questions.map(({ ask }) => ask.prompt))).toEqual([['Q1']])
  })

  test('a conversation without an ask reads nothing', async () => {
    const readCache = mock(async () => null)
    expect(await collectConversationAskStates([message('a', 'assistant', 'Hi')], readCache)).toEqual([])
    expect(readCache).not.toHaveBeenCalled()
  })
})
