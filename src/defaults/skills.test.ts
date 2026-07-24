/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, test } from 'bun:test'

import { instructions as askWidgetInstruction } from '@/widgets/ask/instructions'
import { instructions as connectIntegrationWidgetInstruction } from '@/widgets/connect-integration/instructions'
import { instructions as linkPreviewWidgetInstruction } from '@/widgets/link-preview/instructions'
import { instructions as mapWidgetInstruction } from '@/widgets/map/instructions'
import { instructions as weatherForecastWidgetInstruction } from '@/widgets/weather-forecast/instructions'
import {
  defaultSkillAsk,
  defaultSkillConnectIntegration,
  defaultSkillLinkPreview,
  defaultSkillMap,
  defaultSkills,
  defaultSkillsVersion,
  defaultSkillWeatherForecast,
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
  version: 3,
  hash: '0:01996330-0000-7000-8000-000000000001:-eur3ct|1:01996330-0000-7000-8000-000000000002:lp36jd|2:01996330-0000-7000-8000-000000000003:-oawvjh|3:01996330-0000-7000-8000-000000000004:22br3x|4:01996330-0000-7000-8000-000000000005:-72ymfz|5:01996330-0000-7000-8000-000000000006:-31t7et|6:01996330-0000-7000-8000-000000000007:-rhvl8t',
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
  it('ships spontaneous widget skills with load-bearing descriptions and canonical instruction bodies', () => {
    const widgetSkills = [
      {
        skill: defaultSkillWeatherForecast,
        description: 'Use this skill when the user asks for a current or upcoming weather forecast.',
        instruction: weatherForecastWidgetInstruction,
      },
      {
        skill: defaultSkillLinkPreview,
        description:
          'Use this skill when the user wants web results, news, products, recommendations, or other fetched pages shown as rich link previews.',
        instruction: linkPreviewWidgetInstruction,
      },
      {
        skill: defaultSkillConnectIntegration,
        description:
          'Use this skill when the user asks to access email or calendar but required Google or Microsoft tools are unavailable.',
        instruction: connectIntegrationWidgetInstruction,
      },
      {
        skill: defaultSkillAsk,
        description: 'Use this skill when asking the user to choose from options or answer an interactive quiz prompt.',
        instruction: askWidgetInstruction,
      },
      {
        skill: defaultSkillMap,
        description:
          'Use this skill when the user asks to see locations, routes, regions, or other geographic results on an interactive map.',
        instruction: mapWidgetInstruction,
      },
    ]

    for (const { skill, description, instruction } of widgetSkills) {
      expect(defaultSkills).toContain(skill)
      expect(skill.description).toBe(description)
      expect(skill.description).not.toContain('\n')
      expect(skill.instruction).toBe(instruction)
    }
  })

  it('does not seed flow-coupled citation or document-result contracts as user-invoked skills', () => {
    const names = defaultSkills.map((skill) => skill.name)

    expect(names).not.toContain('citation')
    expect(names).not.toContain('document-result')
  })

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
