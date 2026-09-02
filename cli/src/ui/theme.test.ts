/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { brandGradient } from './theme.ts'

test('brand gradient supports truecolor, 256-color, and plain output', () => {
  const truecolor = brandGradient('bolt', 'truecolor')
  const ansi256 = brandGradient('bolt', 'ansi256')

  expect(truecolor).toContain('\x1b[38;2;')
  expect(truecolor).toContain('b')
  expect(truecolor).toContain('t')
  expect(ansi256).toContain('\x1b[38;5;')
  expect(brandGradient('bolt', 'plain')).toBe('bolt')
})
