/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isComposerOnScreen } from './artifact-sidebar-content'

describe('isComposerOnScreen', () => {
  it('is true beside a desktop chat, so the panel can stay open', () => {
    expect(isComposerOnScreen({ isMobile: false, isChatRoute: true })).toBe(true)
  })

  it('is false on mobile, where the panel covers the chat', () => {
    expect(isComposerOnScreen({ isMobile: true, isChatRoute: true })).toBe(false)
  })

  it('is false on a Mini App route, where the panel takes the chat slot', () => {
    expect(isComposerOnScreen({ isMobile: false, isChatRoute: false })).toBe(false)
  })
})
