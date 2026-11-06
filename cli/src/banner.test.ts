/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { bannerHint, bannerText } from './banner.ts'

test('banner uses the approved wordmark, hairline, and discoverability hint', () => {
  const lines = bannerText(80).split('\n')

  expect(lines[0]).toContain('⚡')
  expect(lines[0]).toContain('thunderbolt')
  expect(lines[1]).toContain('─')
  expect(lines[2]).toContain(bannerHint)
})

test('banner hairline contracts with terminal width', () => {
  const wideHairline = bannerText(120).split('\n')[1] ?? ''
  const narrowHairline = bannerText(40).split('\n')[1] ?? ''

  expect(narrowHairline.length).toBeLessThan(wideHairline.length)
})
