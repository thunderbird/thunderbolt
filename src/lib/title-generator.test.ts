/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { quotePartType } from '@/lib/quotes'
import { i18n } from '@lingui/core'
import { describe, expect, test } from 'bun:test'
import { defaultChatTitle } from './constants'
import { titleSourceText, chatTitleLabel } from './title-generator'

describe('chatTitleLabel', () => {
  test('translates the untitled sentinel rather than storing it per locale', () => {
    // The stored value stays `defaultChatTitle` — it is compared on hydration to
    // decide whether to auto-title, so a localized row would break that.
    expect(chatTitleLabel(i18n, defaultChatTitle)).toBe('New Chat')
  })

  test('falls back for a thread with no title at all', () => {
    expect(chatTitleLabel(i18n, null)).toBe('Untitled chat')
    expect(chatTitleLabel(i18n, undefined)).toBe('Untitled chat')
    expect(chatTitleLabel(i18n, '')).toBe('Untitled chat')
  })

  test('passes a real title through untouched', () => {
    expect(chatTitleLabel(i18n, 'Trip to Berlin')).toBe('Trip to Berlin')
    // A user is free to name a thread after the sentinel's translation; only the
    // sentinel itself is substituted.
    expect(chatTitleLabel(i18n, 'New Chat ideas')).toBe('New Chat ideas')
  })
})

describe('titleSourceText', () => {
  const message = (parts: unknown[]) => ({ id: 'm1', role: 'user', parts }) as unknown as ThunderboltUIMessage

  test('reads typed text', () => {
    expect(titleSourceText(message([{ type: 'text', text: 'what is this chart' }]))).toBe('what is this chart')
  })

  /*
   * The bug this exists for: "Ask about this" on an artifact or a Mini App sends
   * a message whose only part is a quote, so the title source was empty and the
   * thread stayed "New Chat" forever.
   */
  test('reads a quoted passage when there is no typed text', () => {
    const parts = [{ type: quotePartType, data: { text: 'EMEA revenue 4.2M' } }]
    expect(titleSourceText(message(parts))).toBe('EMEA revenue 4.2M')
  })

  test('combines typed text with quoted passages', () => {
    const parts = [
      { type: 'text', text: 'why is this down' },
      { type: quotePartType, data: { text: 'APAC 1.98M' } },
    ]
    expect(titleSourceText(message(parts))).toBe('why is this down APAC 1.98M')
  })

  test('joins several quotes, as a marquee selection produces', () => {
    const parts = [
      { type: quotePartType, data: { text: 'Row A' } },
      { type: quotePartType, data: { text: 'Row B' } },
    ]
    expect(titleSourceText(message(parts))).toBe('Row A Row B')
  })

  /** Nothing usable must stay empty, so the caller leaves the default title alone. */
  test('returns an empty string for a message with no text or quotes', () => {
    expect(titleSourceText(message([{ type: 'file', url: 'x' }]))).toBe('')
  })
})
