/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { describe, expect, test } from 'bun:test'
import { defaultChatTitle } from './constants'
import { chatTitleLabel } from './title-generator'

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
