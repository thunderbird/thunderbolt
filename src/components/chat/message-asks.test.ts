/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { collectMessageAsks } from './message-asks'

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
