/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, test } from 'bun:test'

import {
  defaultSkillImportantEmails,
  defaultSkillResearch,
  defaultSkills,
  defaultSkillSearch,
  defaultSkillsVersion,
  defaultSkillWeather,
  hashSkill,
} from './skills'

/**
 * Snapshot pinning the shipped defaults to their declared version. When you
 * change any default skill (add/remove/edit/reorder), this test fails.
 *
 * Fix it in this order:
 *   1. Bump `defaultSkillsVersion` in `src/defaults/skills.ts`.
 *   2. Update `expected` below to match the actual values from the failure.
 *
 * The version is the ordering signal reconcile uses to decide who owns the
 * newest defaults across devices (THU-637 pattern extended to skills in
 * THU-677). Changing defaults without bumping the version breaks that
 * ordering silently.
 */
const computeSnapshotHash = () =>
  defaultSkills.map((skill, index) => `${index}:${skill.id}:${hashSkill(skill)}`).join('|')

const expectedSnapshot = {
  version: 4,
  hash: '0:01996330-0000-7000-8000-000000000001:mfmi05|1:01996330-0000-7000-8000-000000000002:-669lkj|2:01996330-0000-7000-8000-000000000003:-30vmih|3:01996330-0000-7000-8000-000000000004:-cz2tdq|4:01996330-0000-7000-8000-000000000005:-d0466u',
}

describe('defaultSkills version snapshot', () => {
  test('version and content are in sync — read the file header if this fails', () => {
    expect({
      version: defaultSkillsVersion,
      hash: computeSnapshotHash(),
    }).toEqual(expectedSnapshot)
  })
})

describe('defaultSkills', () => {
  it('pins exactly Search, Research, Weather (in that order) as the starter chips for new users', () => {
    // Regression guard — Chris chose this exact pinned starter set. Pinning is
    // manageable only from the chat composer, so the seed decides what new
    // users see in the chip bar.
    const pinned = defaultSkills
      .filter((s) => s.pinnedOrder !== null)
      .sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0))
    expect(pinned).toEqual([defaultSkillSearch, defaultSkillResearch, defaultSkillWeather])
  })

  it('seeds Important Emails disabled and everything else enabled', () => {
    for (const skill of defaultSkills) {
      expect(skill.enabled).toBe(skill === defaultSkillImportantEmails ? 0 : 1)
    }
  })
})
