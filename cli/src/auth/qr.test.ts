/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the link-only fallback decision. The QR render itself is a
 * best-effort side effect and intentionally not unit-tested; only the gate that
 * chooses link-only vs QR is.
 */

import { describe, expect, test } from 'bun:test'
import { shouldRenderQr } from './qr.ts'

describe('shouldRenderQr', () => {
  test('renders on a wide interactive TTY', () => {
    expect(shouldRenderQr({ isTty: true, columns: 80 })).toBe(true)
    expect(shouldRenderQr({ isTty: true, columns: 200 })).toBe(true)
  })

  test('falls back to link-only when not a TTY (piped/redirected)', () => {
    expect(shouldRenderQr({ isTty: false, columns: 200 })).toBe(false)
  })

  test('falls back to link-only when the terminal is too narrow', () => {
    expect(shouldRenderQr({ isTty: true, columns: 79 })).toBe(false)
  })
})
