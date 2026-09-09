/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  isExternalLinkBehavior,
  resolveLinkAction,
  type ExternalLinkAction,
  type ExternalLinkBehavior,
} from './external-link-behavior'

describe('isExternalLinkBehavior', () => {
  it('accepts the three known behaviors', () => {
    expect(isExternalLinkBehavior('ask')).toBe(true)
    expect(isExternalLinkBehavior('sidebar')).toBe(true)
    expect(isExternalLinkBehavior('browser')).toBe(true)
  })

  it('rejects the empty string Radix emits when a selected toggle is clicked again', () => {
    expect(isExternalLinkBehavior('')).toBe(false)
  })

  it('rejects unknown values', () => {
    expect(isExternalLinkBehavior('Browser')).toBe(false)
    expect(isExternalLinkBehavior('new-tab')).toBe(false)
  })
})

describe('resolveLinkAction', () => {
  const cases: [ExternalLinkBehavior, { canUseSidebar: boolean; isSafe: boolean }, ExternalLinkAction, string][] = [
    ['ask', { canUseSidebar: true, isSafe: true }, 'dialog', 'ask always confirms, even where the panel exists'],
    ['ask', { canUseSidebar: false, isSafe: true }, 'dialog', 'ask always confirms'],
    ['browser', { canUseSidebar: false, isSafe: true }, 'browser', 'browser opens without confirmation'],
    ['browser', { canUseSidebar: true, isSafe: true }, 'browser', 'browser wins over an available panel'],
    [
      'browser',
      { canUseSidebar: true, isSafe: false },
      'browser',
      'browser defers validation to the opener so it can show a reason',
    ],
    ['sidebar', { canUseSidebar: true, isSafe: true }, 'sidebar', 'sidebar uses the panel when available'],
    ['sidebar', { canUseSidebar: false, isSafe: true }, 'dialog', 'sidebar degrades where the panel is unavailable'],
    ['sidebar', { canUseSidebar: true, isSafe: false }, 'dialog', 'sidebar never renders an unsafe URL in the panel'],
  ]

  for (const [behavior, opts, expected, why] of cases) {
    it(`${behavior} + ${JSON.stringify(opts)} -> ${expected} (${why})`, () => {
      expect(resolveLinkAction(behavior, opts)).toBe(expected)
    })
  }
})
