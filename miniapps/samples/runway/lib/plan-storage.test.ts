/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { defaultPlan, type Plan } from './model'
import { parsePlan, serializePlan } from './plan-storage'

const custom: Plan = {
  ...defaultPlan,
  startingCash: 123_456,
  hires: [{ role: 'CTO', monthlyCost: 12_000, startMonth: '2027-02' }],
  rounds: [],
}

describe('parsePlan', () => {
  it('round-trips a custom plan', () => {
    expect(parsePlan(serializePlan(custom))).toEqual(custom)
  })

  it('falls back to defaults when nothing is stored', () => {
    expect(parsePlan(null)).toEqual(defaultPlan)
  })

  it('falls back on malformed JSON', () => {
    expect(parsePlan('{nope')).toEqual(defaultPlan)
  })

  it('falls back on the wrong shape', () => {
    expect(parsePlan('null')).toEqual(defaultPlan)
    expect(parsePlan('[]')).toEqual(defaultPlan)
    expect(parsePlan(JSON.stringify({ ...custom, startingCash: 'lots' }))).toEqual(defaultPlan)
    expect(parsePlan(JSON.stringify({ ...custom, hires: [{ role: 'x' }] }))).toEqual(defaultPlan)
    expect(parsePlan(JSON.stringify({ ...custom, rounds: [{ label: 'x', amount: 1, month: '2027-99' }] }))).toEqual(
      defaultPlan,
    )
  })
})

describe('serializePlan', () => {
  it('returns null for the default plan so a reset clears storage', () => {
    expect(serializePlan(defaultPlan)).toBeNull()
    expect(serializePlan(custom)).toBeString()
  })
})
