/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { resolveSkillWebToolIntent, resolveWebToolIntent } from './turn-web-budget'

describe('resolveWebToolIntent', () => {
  it.each([
    ['/search latest releases', 'search'],
    ['compare these /research sources', 'research'],
    ['please search for this', 'auto'],
    ['/search then /research', 'research'],
    ['/research then /search', 'research'],
    ['https://example.test/research', 'auto'],
    ['/research.', 'auto'],
    ['/Research', 'auto'],
    ['/unknown', 'auto'],
    ['', 'auto'],
  ] as const)('resolves %s to %s', (text, intent) => {
    expect(resolveWebToolIntent(text)).toBe(intent)
  })

  it.each([
    ['search', 'search'],
    ['research', 'research'],
    ['weather', 'auto'],
  ] as const)('resolves canonical %s and its command to the same intent', (name, intent) => {
    expect(resolveSkillWebToolIntent(name)).toBe(intent)
    expect(resolveWebToolIntent(`/${name}`)).toBe(intent)
  })
})
