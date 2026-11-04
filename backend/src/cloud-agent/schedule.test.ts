/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { CloudScheduleConfig } from '@shared/cloud-agent/contracts'
import { nextOccurrence, scheduleCommandId } from './schedule'

const daily = (hour: number, minute: number, timezone = 'America/New_York'): CloudScheduleConfig => ({
  name: 'Daily',
  prompt: 'Run',
  timezone,
  cadence: { type: 'daily', hour, minute },
})
describe('cloud schedule occurrence policy', () => {
  it('skips a nonexistent spring-forward wall time instead of shifting it', () => {
    expect(nextOccurrence(daily(2, 30), new Date('2026-03-08T06:00:00Z'))).toBe('2026-03-09T06:30:00.000Z')
    expect(nextOccurrence(daily(2, 30), new Date('2026-03-07T08:00:00Z'))).toBe('2026-03-09T06:30:00.000Z')
  })
  it('uses the first fall-back occurrence and never repeats it, including after a late wake-up', () => {
    expect(nextOccurrence(daily(1, 30), new Date('2026-11-01T05:20:00Z'))).toBe('2026-11-01T05:30:00.000Z')
    expect(nextOccurrence(daily(1, 30), new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-02T06:30:00.000Z')
    expect(nextOccurrence(daily(1, 30), new Date('2026-11-01T06:20:00Z'))).toBe('2026-11-02T06:30:00.000Z')
  })
  it('handles a half-hour daylight transition without assuming one-hour offsets', () => {
    expect(nextOccurrence(daily(2, 15, 'Australia/Lord_Howe'), new Date('2026-10-03T14:00:00Z'))).toBe(
      '2026-10-04T15:15:00.000Z',
    )
    expect(nextOccurrence(daily(1, 45, 'Australia/Lord_Howe'), new Date('2026-04-04T15:05:00Z'))).toBe(
      '2026-04-05T15:15:00.000Z',
    )
  })
  it('advances intervals from now to coalesce a missed backlog', () => {
    const config: CloudScheduleConfig = {
      name: 'Periodic',
      prompt: 'Run',
      timezone: 'UTC',
      cadence: { type: 'interval', minutes: 30 },
    }
    expect(nextOccurrence(config, new Date('2026-10-23T12:17:00Z'))).toBe('2026-10-23T12:47:00.000Z')
    expect(() => nextOccurrence({ ...config, timezone: 'Invalid/Zone' }, new Date())).toThrow()
  })
  it('makes an occurrence ID stable across timestamp representations and distinct per schedule or instant', () => {
    const id = crypto.randomUUID()
    const first = scheduleCommandId(id, '2026-10-23T12:00:00Z')
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(scheduleCommandId(id, '2026-10-23T08:00:00-04:00')).toBe(first)
    expect(scheduleCommandId(id, '2026-10-23T12:01:00Z')).not.toBe(first)
    expect(scheduleCommandId(crypto.randomUUID(), '2026-10-23T12:00:00Z')).not.toBe(first)
  })
})
