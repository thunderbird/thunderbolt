/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { sharedHeaderHasControls } from './shared-header'

describe('sharedHeaderHasControls', () => {
  it('lets expanded pages own their header', () => {
    expect(sharedHeaderHasControls('/pages/html-one')).toBe(false)
  })

  it('retains navigation for chat, settings, and unknown old app routes', () => {
    for (const pathname of ['/chats/abc', '/settings/models', '/apps/retired-app', '/settings/pages']) {
      expect(sharedHeaderHasControls(pathname)).toBe(true)
    }
  })
})
