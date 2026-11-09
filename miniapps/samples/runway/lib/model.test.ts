/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { defaultPlan, headline, monthLabel, parseMonth, project, summarize, type Plan } from './model'

/** Flat plan: no growth, no hires, no rounds. Burns 10k net a month from 100k. */
const flat: Plan = {
  startingCash: 100_000,
  monthlyRevenue: 40_000,
  revenueGrowth: 0,
  baseBurn: 50_000,
  hires: [],
  rounds: [],
}

const runwayOf = (plan: Plan) => summarize(project(plan)).runwayMonths

describe('months', () => {
  it('labels and parses month indices', () => {
    expect(monthLabel(0)).toBe('Jan 2027')
    expect(monthLabel(23)).toBe('Dec 2028')
    expect(parseMonth('2027-03')).toBe(2)
    expect(parseMonth('2028-12')).toBe(23)
    expect(parseMonth('nope')).toBeNull()
    expect(parseMonth('2027-13')).toBeNull()
  })
})

describe('runway', () => {
  it('runs out in the first month cash goes negative', () => {
    const summary = summarize(project(flat))
    // 100k - 10k a month: Oct 2027 (index 9) ends at exactly 0, Nov (index 10) goes negative.
    expect(summary.runwayMonths).toBe(10)
    expect(summary.zeroCashMonth).toBe('Nov 2027')
    expect(headline(summary)).toBe('Runway: 10 months, cash runs out in Nov 2027')
  })

  it('is extended by a funding round', () => {
    const funded = { ...flat, rounds: [{ label: 'Seed', amount: 100_000, month: '2027-06' }] }
    expect(runwayOf(funded)).toBe(20)
  })

  it('is shortened by a hire', () => {
    const hired = { ...flat, hires: [{ role: 'Engineer', monthlyCost: 10_000, startMonth: '2027-01' }] }
    expect(runwayOf(hired)).toBe(5)
    const late = { ...flat, hires: [{ role: 'Engineer', monthlyCost: 10_000, startMonth: '2027-07' }] }
    expect(runwayOf(late)).toBeLessThan(runwayOf(flat)!)
    expect(runwayOf(late)).toBeGreaterThan(5)
  })

  it('is null when cash never runs out', () => {
    const summary = summarize(project({ ...flat, monthlyRevenue: 60_000 }))
    expect(summary.runwayMonths).toBeNull()
    expect(summary.zeroCashMonth).toBeNull()
    expect(headline(summary)).toBe('Cash-positive through Dec 2028')
  })
})

describe('break-even', () => {
  it('finds the first month revenue covers costs', () => {
    // 20k revenue growing 10% a month against 50k of costs: crosses 50k at month 10.
    const plan = { ...flat, monthlyRevenue: 20_000, revenueGrowth: 10, startingCash: 5_000_000 }
    expect(summarize(project(plan)).breakEvenMonth).toBe('Nov 2027')
  })

  it('is null when revenue never catches up', () => {
    expect(summarize(project(flat)).breakEvenMonth).toBeNull()
  })
})

describe('default plan', () => {
  it('runs out inside the window so the demo has something to change', () => {
    const runway = runwayOf(defaultPlan)
    expect(runway).not.toBeNull()
    expect(runway!).toBeGreaterThan(6)
    expect(runway!).toBeLessThan(24)
  })
})
