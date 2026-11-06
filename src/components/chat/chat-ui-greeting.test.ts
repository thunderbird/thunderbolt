/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { describe, expect, it } from 'bun:test'

import { getGreeting } from './chat-ui-greeting'

/** Resolve the descriptor the way the chat header does. */
const greeting = (hour: number) => i18n._(getGreeting(hour))

describe('getGreeting', () => {
  it('greets the night owl before 5am', () => {
    expect(greeting(0)).toBe('Up late?')
    expect(greeting(4)).toBe('Up late?')
  })

  it('says good morning from 5am until noon', () => {
    expect(greeting(5)).toBe('Good morning')
    expect(greeting(11)).toBe('Good morning')
  })

  it('says good afternoon from noon until 6pm', () => {
    expect(greeting(12)).toBe('Good afternoon')
    expect(greeting(17)).toBe('Good afternoon')
  })

  it('says good evening from 6pm onward', () => {
    expect(greeting(18)).toBe('Good evening')
    expect(greeting(23)).toBe('Good evening')
  })
})
