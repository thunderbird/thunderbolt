/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import {
  buildDisplayNameToSlug,
  skillDisplayName,
  skillMatchesQuery,
  titleCaseFromSlug,
  tokenForSkill,
} from './display'

describe('skillDisplayName', () => {
  it('returns the label when present', () => {
    expect(skillDisplayName({ name: 'daily-brief', label: 'Daily Brief' })).toBe('Daily Brief')
  })

  it('falls back to a title-cased slug when label is null (legacy rows)', () => {
    expect(skillDisplayName({ name: 'daily-brief', label: null })).toBe('Daily Brief')
  })

  it('falls back to a title-cased slug when label is empty or whitespace-only', () => {
    expect(skillDisplayName({ name: 'daily-brief', label: '' })).toBe('Daily Brief')
    expect(skillDisplayName({ name: 'daily-brief', label: '   ' })).toBe('Daily Brief')
  })

  it('trims surrounding whitespace from the label', () => {
    expect(skillDisplayName({ name: 'daily-brief', label: '  Daily Brief  ' })).toBe('Daily Brief')
  })
})

describe('buildDisplayNameToSlug', () => {
  it('maps display names (label or title-cased slug) to slugs', () => {
    const map = buildDisplayNameToSlug([
      { name: 'daily-brief', label: 'Daily Brief' },
      { name: 'triage', label: null },
    ])
    expect(map.get('Daily Brief')).toBe('daily-brief')
    expect(map.get('Triage')).toBe('triage')
  })

  it('omits ambiguous display names entirely (never resolves to the wrong skill)', () => {
    const map = buildDisplayNameToSlug([
      { name: 'brief-a', label: 'Brief' },
      { name: 'brief-b', label: 'Brief' },
      { name: 'other', label: 'Other' },
    ])
    expect(map.has('Brief')).toBe(false)
    expect(map.get('Other')).toBe('other')
  })

  it('treats a label colliding with another skill title-cased slug as ambiguous', () => {
    const map = buildDisplayNameToSlug([
      { name: 'daily-brief', label: null },
      { name: 'brief-two', label: 'Daily Brief' },
    ])
    expect(map.has('Daily Brief')).toBe(false)
  })
})

describe('skillMatchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(skillMatchesQuery({ name: 'daily-brief', label: null }, '')).toBe(true)
  })

  it('matches a substring of the slug, case-insensitively', () => {
    expect(skillMatchesQuery({ name: 'daily-brief', label: 'Standup' }, 'ly-br')).toBe(true)
    expect(skillMatchesQuery({ name: 'daily-brief', label: 'Standup' }, 'DAILY')).toBe(true)
  })

  it('matches a substring of the label display name', () => {
    expect(skillMatchesQuery({ name: 'daily-brief', label: 'Morning Standup' }, 'standup')).toBe(true)
  })

  it('matches the title-cased fallback display name for label-less legacy rows', () => {
    // Displayed as "Meeting Notes" — typing "notes" must find it.
    expect(skillMatchesQuery({ name: 'meeting-notes', label: null }, 'notes')).toBe(true)
  })

  it('returns false when the query appears in neither slug nor display name', () => {
    expect(skillMatchesQuery({ name: 'daily-brief', label: 'Morning Standup' }, 'triage')).toBe(false)
  })
})

describe('tokenForSkill', () => {
  it('returns the display name when it is present in the map', () => {
    const map = buildDisplayNameToSlug([{ name: 'daily-brief', label: 'Daily Brief' }])
    expect(tokenForSkill({ name: 'daily-brief', label: 'Daily Brief' }, map)).toBe('Daily Brief')
  })

  it('returns the title-cased fallback name for label-less rows when unambiguous', () => {
    const map = buildDisplayNameToSlug([{ name: 'meeting-notes', label: null }])
    expect(tokenForSkill({ name: 'meeting-notes', label: null }, map)).toBe('Meeting Notes')
  })

  it('falls back to the slug when the display name is ambiguous (absent from the map)', () => {
    const map = buildDisplayNameToSlug([
      { name: 'brief-a', label: 'Brief' },
      { name: 'brief-b', label: 'Brief' },
    ])
    expect(tokenForSkill({ name: 'brief-a', label: 'Brief' }, map)).toBe('brief-a')
  })
})

describe('titleCaseFromSlug', () => {
  it('title-cases each hyphen-separated word', () => {
    expect(titleCaseFromSlug('daily-brief')).toBe('Daily Brief')
    expect(titleCaseFromSlug('important-emails')).toBe('Important Emails')
  })

  it('handles single-word slugs', () => {
    expect(titleCaseFromSlug('brief')).toBe('Brief')
  })

  it('keeps digits as-is', () => {
    expect(titleCaseFromSlug('q3-report')).toBe('Q3 Report')
  })

  it('ignores empty segments from stray hyphens', () => {
    expect(titleCaseFromSlug('daily--brief')).toBe('Daily Brief')
    expect(titleCaseFromSlug('')).toBe('')
  })
})
