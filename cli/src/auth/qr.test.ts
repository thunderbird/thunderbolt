/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { renderTerminalQr, shouldRenderQr } from './qr.ts'

describe('shouldRenderQr', () => {
  test('renders on a wide interactive TTY', () => {
    expect(shouldRenderQr({ isTty: true, columns: 80 })).toBe(true)
    expect(shouldRenderQr({ isTty: true, columns: 200 })).toBe(true)
  })

  test('renders a real QR block without losing the CommonJS receiver', () => {
    const output = renderTerminalQr('https://example.com/device?user_code=ABCD-EFGH')

    expect(output).toContain('\n')
    expect(output.length).toBeGreaterThan(100)
  })

  test('falls back to link-only when not a TTY (piped/redirected)', () => {
    expect(shouldRenderQr({ isTty: false, columns: 200 })).toBe(false)
  })

  test('falls back to link-only when the terminal is too narrow', () => {
    expect(shouldRenderQr({ isTty: true, columns: 79 })).toBe(false)
  })
})
