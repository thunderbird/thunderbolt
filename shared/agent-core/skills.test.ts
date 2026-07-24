/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  buildSkillCatalog,
  buildSkillListing,
  buildWireSkillsMeta,
  readWireSkills,
  resolveSkill,
  skillsCapabilityMeta,
  supportsWireSkills,
  thunderboltAcpMetaKey,
  type SkillDefinition,
} from './skills.ts'

const skills: SkillDefinition[] = [
  {
    name: 'daily-brief',
    description: 'Use for a daily rundown.\nIncludes weather and calendar.',
    instruction: 'Gather current weather, news, email, and calendar details.',
  },
  {
    name: 'meeting-notes',
    description: 'Use when summarizing meetings.',
    instruction: 'Extract decisions and action items.',
  },
]

describe('buildSkillListing', () => {
  it('lists one skill name and description per line without instruction bodies', () => {
    const listing = buildSkillListing(skills)

    expect(listing?.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      '- daily-brief: Use for a daily rundown. Includes weather and calendar.',
      '- meeting-notes: Use when summarizing meetings.',
    ])
    expect(listing).not.toContain('Gather current weather')
    expect(listing).not.toContain('Extract decisions')
  })

  it('omits the section when no skills are available', () => {
    expect(buildSkillListing([])).toBeUndefined()
  })
})

describe('buildSkillCatalog', () => {
  it('builds compact entries without tool guidance', () => {
    expect(buildSkillCatalog(skills)).toBe(
      '- daily-brief: Use for a daily rundown. Includes weather and calendar.\n' +
        '- meeting-notes: Use when summarizing meetings.',
    )
    expect(buildSkillCatalog([])).toBeUndefined()
  })
})

describe('resolveSkill', () => {
  it('resolves bare and slash-prefixed names', () => {
    expect(resolveSkill(skills, 'daily-brief')).toBe(skills[0])
    expect(resolveSkill(skills, ' /meeting-notes ')).toBe(skills[1])
  })

  it('returns null for an unavailable name', () => {
    expect(resolveSkill(skills, 'unknown')).toBeNull()
  })
})

describe('ACP wire skills metadata', () => {
  it('advertises support through namespaced capability metadata', () => {
    expect(skillsCapabilityMeta).toEqual({
      [thunderboltAcpMetaKey]: { skills: true },
    })
    expect(supportsWireSkills(skillsCapabilityMeta)).toBe(true)
    expect(supportsWireSkills({ [thunderboltAcpMetaKey]: { skills: false } })).toBe(false)
    expect(supportsWireSkills(undefined)).toBe(false)
  })

  it('round-trips full skill definitions through namespaced session metadata', () => {
    const meta = buildWireSkillsMeta(skills)

    expect(meta).toEqual({
      [thunderboltAcpMetaKey]: { skills },
    })
    expect(readWireSkills(meta)).toEqual(skills)
  })

  it('ignores missing and malformed wire entries', () => {
    expect(readWireSkills(undefined)).toEqual([])
    expect(
      readWireSkills({
        [thunderboltAcpMetaKey]: {
          skills: [skills[0], { name: 'missing-body', description: 'Broken' }],
        },
      }),
    ).toEqual([skills[0]])
  })
})
