/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { skillDisplayName, titleCaseFromSlug } from './display'

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
