/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { describe, expect, test } from 'bun:test'
import { buildQuotePart, getQuotes, hydrateQuotesAsText, isQuotePart, quotePartType } from './quotes'

const quote = { text: 'the mitochondria is the powerhouse of the cell', sourceMessageId: 'm0' }

const messageWith = (...parts: unknown[]): ThunderboltUIMessage =>
  ({ id: 'm1', role: 'user', parts }) as unknown as ThunderboltUIMessage

describe('quotes', () => {
  test('buildQuotePart wraps the passage in a data-quote part', () => {
    expect(buildQuotePart(quote)).toEqual({ type: quotePartType, data: quote })
  })

  test('isQuotePart matches only quote parts', () => {
    expect(isQuotePart({ type: quotePartType })).toBe(true)
    expect(isQuotePart({ type: 'text' })).toBe(false)
    expect(isQuotePart({ type: 'data-attachment' })).toBe(false)
  })

  test('getQuotes extracts passages in order, ignoring other parts', () => {
    const message = messageWith(
      { type: 'text', text: 'what about this?' },
      buildQuotePart(quote),
      buildQuotePart({ text: 'second' }),
    )
    expect(getQuotes(message).map((q) => q.text)).toEqual([quote.text, 'second'])
  })

  test('hydrateQuotesAsText replaces quote parts with a Markdown blockquote text part', () => {
    const [message] = hydrateQuotesAsText([messageWith(buildQuotePart(quote), { type: 'text', text: 'follow-up' })])
    expect(message.parts).toEqual([
      { type: 'text', text: '> the mitochondria is the powerhouse of the cell' },
      { type: 'text', text: 'follow-up' },
    ] as ThunderboltUIMessage['parts'])
  })

  test('hydrateQuotesAsText prefixes every line of a multi-line quote', () => {
    const [message] = hydrateQuotesAsText([messageWith(buildQuotePart({ text: 'line one\nline two' }))])
    expect(message.parts).toEqual([{ type: 'text', text: '> line one\n> line two' }] as ThunderboltUIMessage['parts'])
  })

  test('hydrateQuotesAsText leaves messages without quotes untouched (same reference)', () => {
    const messages = [messageWith({ type: 'text', text: 'plain' })]
    expect(hydrateQuotesAsText(messages)[0]).toBe(messages[0])
  })
})
