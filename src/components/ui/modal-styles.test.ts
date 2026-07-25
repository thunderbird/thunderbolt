/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  centeredModalSurfaceClass,
  mobileHeaderControlFillClass,
  modalCloseClass,
  modalOverlayClass,
} from './modal-styles'

describe('shared modal classes', () => {
  it('keeps overlay, hero surface, and close-control treatments centralized', () => {
    expect(modalOverlayClass).toContain('backdrop-blur-md')
    expect(centeredModalSurfaceClass).toContain('rounded-2xl')
    expect(modalCloseClass).toContain('rounded-full')
  })

  it('rings the close control only on focus-visible, so mount focus stays invisible to touch', () => {
    expect(modalCloseClass).toContain('focus-visible:ring-[3px]')
    expect(modalCloseClass).not.toMatch(/(^|\s)focus:/)
  })

  it('paints the close control at rest on mobile only, keeping desktop hover-only', () => {
    expect(modalCloseClass).toContain(mobileHeaderControlFillClass)
    expect(modalCloseClass).toContain('max-md:bg-muted/80')
    expect(modalCloseClass).not.toMatch(/(^|\s)bg-muted(\s|$)/)
  })

  it('frosts the mobile fill so content scrolling behind it stays readable', () => {
    // Translucent at 80% over bg-background reads as flat bg-muted, so the
    // effect only shows itself when there is content underneath.
    expect(mobileHeaderControlFillClass).toContain('max-md:bg-muted/80')
    expect(mobileHeaderControlFillClass).toContain('max-md:backdrop-blur-md')
  })

  it('keeps a deeper press fill inside the mobile media query so taps stay legible', () => {
    // Unprefixed `active:` would lose to the resting `max-md:` fill.
    expect(mobileHeaderControlFillClass).toContain('max-md:active:bg-')
  })
})
