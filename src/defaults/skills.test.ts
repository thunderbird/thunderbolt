/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, test } from 'bun:test'

import { defaultSkills, defaultSkillsVersion, hashSkill } from './skills'

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
  version: 2,
  hash: '0:01996330-0000-7000-8000-000000000001:-eur3ct|1:01996330-0000-7000-8000-000000000002:lp36jd',
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
  it('seeds every default with a pinnedOrder so new users start with pinned chips in chat', () => {
    // Regression guard — Chris flagged that seeded skills must be pinned by
    // default. Pinning is now manageable only from the chat composer; a new
    // user with no pinned defaults would see the chip bar empty until they
    // open the `+` popover and pin one manually, which loses the "starter
    // chip is ready" affordance that the legacy automations gave them.
    for (const skill of defaultSkills) {
      expect(typeof skill.pinnedOrder).toBe('number')
      expect(skill.pinnedOrder).not.toBeNull()
    }
  })

  it('assigns each default a unique pinnedOrder so the order is stable on seed', () => {
    const orders = defaultSkills.map((s) => s.pinnedOrder)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('seeds every default as enabled — disabled defaults would never reach the chat resolver', () => {
    for (const skill of defaultSkills) {
      expect(skill.enabled).toBe(1)
    }
  })
})
