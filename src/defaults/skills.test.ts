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
  defaultSkillDailyBrief,
  defaultSkillImportantEmails,
  defaultSkillAsk,
  defaultSkillConnectIntegration,
  defaultSkillLinkPreview,
  defaultSkillMap,
  defaultSkillResearch,
  defaultSkills,
  defaultSkillSearch,
  defaultSkillsVersion,
  defaultSkillWeather,
  hashSkill,
  isWidgetSkillId,
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
  version: 6,
  hash: '0:01996330-0000-7000-8000-000000000001:mfmi05|1:01996330-0000-7000-8000-000000000002:-669lkj|2:01996330-0000-7000-8000-000000000003:-30vmih|3:01996330-0000-7000-8000-000000000004:-cz2tdq|4:01996330-0000-7000-8000-000000000005:-hc6mv3|5:01996330-0000-7000-8000-000000000006:-o0c0ul|6:01996330-0000-7000-8000-000000000007:atrnpq|7:01996330-0000-7000-8000-000000000008:-ue9tpd|8:01996330-0000-7000-8000-000000000009:o1nire',
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
        skill: defaultSkillWeather,
        description: 'Use this skill when the user asks about the weather or wants a forecast for a location.',
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

  it('pins exactly Search, Research, Weather (in that order) as the starter chips for new users', () => {
    const pinned = defaultSkills
      .filter((skill) => skill.pinnedOrder !== null)
      .sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0))
    expect(pinned).toEqual([defaultSkillSearch, defaultSkillResearch, defaultSkillWeather])
  })

  it('identifies widget contracts by stable default id', () => {
    for (const skill of [
      defaultSkillWeather,
      defaultSkillLinkPreview,
      defaultSkillConnectIntegration,
      defaultSkillAsk,
      defaultSkillMap,
    ]) {
      expect(isWidgetSkillId(skill.id)).toBe(true)
    }

    expect(isWidgetSkillId(defaultSkillDailyBrief.id)).toBe(false)
    expect(isWidgetSkillId(defaultSkillImportantEmails.id)).toBe(false)
    expect(isWidgetSkillId(defaultSkillSearch.id)).toBe(false)
    expect(isWidgetSkillId(defaultSkillResearch.id)).toBe(false)
    expect(isWidgetSkillId('user-skill-id')).toBe(false)
  })

  it('excludes user-controlled state from widget hashes only', () => {
    expect(hashSkill({ ...defaultSkillWeather, enabled: 0, pinnedOrder: 4 })).toBe(hashSkill(defaultSkillWeather))
    expect(hashSkill({ ...defaultSkillDailyBrief, enabled: 0, pinnedOrder: 4 })).not.toBe(
      hashSkill(defaultSkillDailyBrief),
    )
  })

  it('seeds Important Emails disabled and everything else enabled', () => {
    for (const skill of defaultSkills) {
      expect(skill.enabled).toBe(skill === defaultSkillImportantEmails ? 0 : 1)
    }
  })
})
