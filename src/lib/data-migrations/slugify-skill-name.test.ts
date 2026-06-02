/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { slugifySkillName } from './slugify-skill-name'

describe('slugifySkillName', () => {
  it('lowercases letters', () => {
    expect(slugifySkillName('Daily Brief')).toBe('daily-brief')
  })

  it('collapses runs of non-alphanumeric chars into single hyphens', () => {
    expect(slugifySkillName('Daily   Brief')).toBe('daily-brief')
    expect(slugifySkillName('Daily / Brief')).toBe('daily-brief')
    expect(slugifySkillName("It's a brief — daily!")).toBe('it-s-a-brief-daily')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugifySkillName('  daily-brief  ')).toBe('daily-brief')
    expect(slugifySkillName('!daily-brief?')).toBe('daily-brief')
  })

  it('preserves single hyphens already present', () => {
    expect(slugifySkillName('weekly-review')).toBe('weekly-review')
  })

  it('truncates to 64 chars without leaving a trailing hyphen', () => {
    const longTitle = 'a'.repeat(70)
    expect(slugifySkillName(longTitle)).toBe('a'.repeat(64))
  })

  it('handles unicode by replacing non-ascii letters with hyphens', () => {
    expect(slugifySkillName('café résumé')).toBe('caf-r-sum')
  })

  it('returns null when the title produces an empty slug', () => {
    expect(slugifySkillName('')).toBeNull()
    expect(slugifySkillName('   ')).toBeNull()
    expect(slugifySkillName('!!!')).toBeNull()
    expect(slugifySkillName('---')).toBeNull()
  })
})
