/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { todayDateInput, toExpiresAt } from './credential-expiry'

describe('toExpiresAt', () => {
  it('ends on the last millisecond of the chosen local day', () => {
    const expiresAt = toExpiresAt('2027-03-09')
    const local = new Date(expiresAt!)
    expect([local.getFullYear(), local.getMonth(), local.getDate()]).toEqual([2027, 2, 9])
    expect([local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ])
  })

  it('leaves the expiry to the server without a date', () => {
    expect(toExpiresAt('')).toBeUndefined()
  })
})

describe('todayDateInput', () => {
  it('formats the local date with padding', () => {
    expect(todayDateInput(new Date(2027, 0, 5, 23, 30))).toBe('2027-01-05')
  })
})
