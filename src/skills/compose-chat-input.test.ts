/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import type { Skill } from '@/types'
import { appendSlashToken, computeSkillRefProblems } from './compose-chat-input'
import type { SkillStatusClassifier } from './highlight-skill-tokens'

const skill = (id: string, name: string): Skill => ({
  id,
  name,
  description: `desc for ${name}`,
  instruction: `instruction for ${name}`,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})

describe('appendSlashToken', () => {
  it('returns just the token (plus trailing space) for an empty input', () => {
    expect(appendSlashToken('', 'meeting-notes')).toBe('/meeting-notes ')
  })

  it('returns just the token when the input already holds only that token (no doubling)', () => {
    expect(appendSlashToken('/meeting-notes', 'meeting-notes')).toBe('/meeting-notes ')
    expect(appendSlashToken('  /meeting-notes  ', 'meeting-notes')).toBe('/meeting-notes ')
  })

  it('appends the token with a single space when the input has other content', () => {
    expect(appendSlashToken('summarize this', 'meeting-notes')).toBe('summarize this /meeting-notes ')
  })

  it('collapses trailing whitespace on existing content to a single space', () => {
    expect(appendSlashToken('summarize this   ', 'meeting-notes')).toBe('summarize this /meeting-notes ')
    expect(appendSlashToken('summarize this\n\n', 'meeting-notes')).toBe('summarize this /meeting-notes ')
  })

  it('leaves a different existing slash token in place when appending another', () => {
    expect(appendSlashToken('/weekly-review', 'meeting-notes')).toBe('/weekly-review /meeting-notes ')
  })

  it('appends correctly across newlines', () => {
    expect(appendSlashToken('first line\nsecond line', 'meeting-notes')).toBe('first line\nsecond line /meeting-notes ')
  })
})

describe('computeSkillRefProblems', () => {
  const enabledSkill = skill('id-meeting', 'meeting-notes')
  const disabledSkill = skill('id-triage', 'task-triage')
  const skillBySlug = new Map<string, Skill>([
    ['meeting-notes', enabledSkill],
    ['task-triage', disabledSkill],
  ])
  const classify: SkillStatusClassifier = (slug) => {
    if (slug === 'meeting-notes') {
      return 'enabled'
    }
    if (slug === 'task-triage') {
      return 'disabled'
    }
    return 'unknown'
  }

  it('returns nothing for an empty input', () => {
    expect(computeSkillRefProblems('', classify, skillBySlug)).toEqual([])
  })

  it('returns nothing when the input only references enabled skills', () => {
    expect(computeSkillRefProblems('/meeting-notes hi', classify, skillBySlug)).toEqual([])
  })

  it('flags a committed reference to a disabled skill with its id', () => {
    expect(computeSkillRefProblems('use /task-triage please', classify, skillBySlug)).toEqual([
      { kind: 'disabled', slug: 'task-triage', skillId: 'id-triage' },
    ])
  })

  it('flags a committed reference to an unknown name with no id', () => {
    expect(computeSkillRefProblems('use /no-such-skill please', classify, skillBySlug)).toEqual([
      { kind: 'unknown', slug: 'no-such-skill' },
    ])
  })

  it('skips in-progress tokens (no trailing whitespace, sitting at end of input)', () => {
    // `/no-such-skill` at EOF with no trailing space → still typing.
    expect(computeSkillRefProblems('/no-such-skill', classify, skillBySlug)).toEqual([])
  })

  it('dedupes duplicates by slug', () => {
    expect(computeSkillRefProblems('/task-triage /task-triage me', classify, skillBySlug)).toEqual([
      { kind: 'disabled', slug: 'task-triage', skillId: 'id-triage' },
    ])
  })

  it('handles a mix of enabled / disabled / unknown / duplicate in one input', () => {
    expect(
      computeSkillRefProblems(
        '/meeting-notes then /task-triage then /unknown-one then /meeting-notes then /unknown-one ok',
        classify,
        skillBySlug,
      ),
    ).toEqual([
      { kind: 'disabled', slug: 'task-triage', skillId: 'id-triage' },
      { kind: 'unknown', slug: 'unknown-one' },
    ])
  })
})
