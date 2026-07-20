/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { getGreeting } from './chat-ui-greeting'

describe('getGreeting', () => {
  it('greets the night owl before 5am', () => {
    expect(getGreeting(0)).toBe('Up late?')
    expect(getGreeting(4)).toBe('Up late?')
  })

  it('says good morning from 5am until noon', () => {
    expect(getGreeting(5)).toBe('Good morning')
    expect(getGreeting(11)).toBe('Good morning')
  })

  it('says good afternoon from noon until 6pm', () => {
    expect(getGreeting(12)).toBe('Good afternoon')
    expect(getGreeting(17)).toBe('Good afternoon')
  })

  it('says good evening from 6pm onward', () => {
    expect(getGreeting(18)).toBe('Good evening')
    expect(getGreeting(23)).toBe('Good evening')
  })
})
