/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { getMobileBottomInset, getMobileSidebarWidth, mobileSidebarWidthCss } from './constants'

describe('mobile sidebar width', () => {
  it('uses 80% of narrow viewports and caps wider viewports at 360px', () => {
    expect(getMobileSidebarWidth(320)).toBe(256)
    expect(getMobileSidebarWidth(450)).toBe(360)
    expect(getMobileSidebarWidth(768)).toBe(360)
    expect(mobileSidebarWidthCss).toBe('min(80vw, 360px)')
  })
})

describe('getMobileBottomInset', () => {
  it('pins to the safe area with a 12px floor on native mobile', () => {
    expect(getMobileBottomInset(true)).toBe('max(var(--safe-area-bottom-padding), 12px)')
  })

  it('adds 8px breathing room above the safe area on web mobile', () => {
    expect(getMobileBottomInset(false)).toBe('calc(var(--safe-area-bottom-padding, 0px) + 0.5rem)')
  })
})
