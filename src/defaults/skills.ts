/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { Skill, SkillRow } from '@/types'
import { instructions as askWidgetInstruction } from '@/widgets/ask/instructions'
import { instructions as connectIntegrationWidgetInstruction } from '@/widgets/connect-integration/instructions'
import { instructions as linkPreviewWidgetInstruction } from '@/widgets/link-preview/instructions'
import { instructions as mapWidgetInstruction } from '@/widgets/map/instructions'
import { instructions as weatherForecastWidgetInstruction } from '@/widgets/weather-forecast/instructions'

/**
 * Hash of user-editable fields. Includes `deletedAt` so soft-deletes are
 * treated as a user configuration choice — a user who deletes a default does
 * NOT get it re-seeded on next app init.
 *
 * Accepts raw (nullable) rows as well as `Skill` so the hash-restamp data
 * migration can stamp exactly what reconciliation will later recompute.
 */
export const hashSkill = (
  skill: Pick<SkillRow, 'name' | 'label' | 'description' | 'instruction' | 'enabled' | 'pinnedOrder' | 'deletedAt'>,
): string =>
  hashValues([
    skill.name,
    skill.label,
    skill.description,
    skill.instruction,
    skill.enabled,
    skill.pinnedOrder,
    skill.deletedAt,
  ])

const dailyBriefInstruction = `Create a daily brief with the following sections. Do not ask the user for any missing information — just skip sections for which you are missing information or tools.

1. If you know the user's location, show the 7-day forecast. If not, skip this section.

2. Today's top news stories. Use the fetch_content tool to get the content of apnews.com. Provide the top 10 headlines in an ordered list. Do not include link previews.

3. If you have access to email tools, check the inbox and summarize what has come in over the last 24 hours, focusing on what looks most important. If not, skip this section.

4. If you have access to calendar tools, check the calendar and give a summary of what is coming up for the current day. Provide this as a personal assistant might. If not, skip this section.

Format the brief as follows:

Good <morning/afternoon/evening> <user's name if available>,

Some friendly, witty variation of "I've put together a daily brief for you!" with an emoji.

# Weather

Today's forecast is ____.

# News

1. <headline>
2. <headline>
3. <headline>

# Inbox

This is what's in your inbox that you should be aware of...

# Calendar

This is what you've got on your calendar today...

Do not show skipped sections at all, even placeholders — just skip them entirely.`

const importantEmailsInstruction = `Review the user's inbox and summarize the 5 most important emails that need attention today. Include sender, subject, and why each is important.`

/**
 * Default skills seeded for new users on first sign-in. UUIDs are stable so
 * the reconciler can recognize them across devices and across app restarts.
 * The starter set mirrors the legacy `defaultAutomations` so new users get
 * the same content under the Skills model.
 *
 * Each lands enabled and pinned in the order listed; a user who soft-deletes
 * one will not see it re-seeded.
 */
export const defaultSkillDailyBrief: Skill = {
  id: '01996330-0000-7000-8000-000000000001',
  name: 'daily-brief',
  label: 'Daily Brief',
  description:
    'Use this skill when the user asks for a daily brief, a morning rundown, or a summary of weather, news, inbox, and calendar.',
  instruction: dailyBriefInstruction,
  enabled: 1,
  pinnedOrder: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillImportantEmails: Skill = {
  id: '01996330-0000-7000-8000-000000000002',
  name: 'important-emails',
  label: 'Important Emails',
  description:
    'Use this skill when the user wants to triage their inbox, see what needs attention, or surface the most important emails of the day.',
  instruction: importantEmailsInstruction,
  enabled: 1,
  pinnedOrder: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillWeatherForecast: Skill = {
  id: '01996330-0000-7000-8000-000000000003',
  name: 'weather-forecast',
  label: 'Weather Forecast',
  description: 'Use this skill when the user asks for a current or upcoming weather forecast.',
  instruction: weatherForecastWidgetInstruction,
  enabled: 1,
  pinnedOrder: 2,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillLinkPreview: Skill = {
  id: '01996330-0000-7000-8000-000000000004',
  name: 'link-preview',
  label: 'Link Preview',
  description:
    'Use this skill when the user wants web results, news, products, recommendations, or other fetched pages shown as rich link previews.',
  instruction: linkPreviewWidgetInstruction,
  enabled: 1,
  pinnedOrder: 3,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillConnectIntegration: Skill = {
  id: '01996330-0000-7000-8000-000000000005',
  name: 'connect-integration',
  label: 'Connect Integration',
  description:
    'Use this skill when the user asks to access email or calendar but required Google or Microsoft tools are unavailable.',
  instruction: connectIntegrationWidgetInstruction,
  enabled: 1,
  pinnedOrder: 4,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillAsk: Skill = {
  id: '01996330-0000-7000-8000-000000000006',
  name: 'ask',
  label: 'Ask',
  description: 'Use this skill when asking the user to choose from options or answer an interactive quiz prompt.',
  instruction: askWidgetInstruction,
  enabled: 1,
  pinnedOrder: 5,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillMap: Skill = {
  id: '01996330-0000-7000-8000-000000000007',
  name: 'map',
  label: 'Map',
  description:
    'Use this skill when the user asks to see locations, routes, regions, or other geographic results on an interactive map.',
  instruction: mapWidgetInstruction,
  enabled: 1,
  pinnedOrder: 6,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkills: ReadonlyArray<Skill> = [
  defaultSkillDailyBrief,
  defaultSkillImportantEmails,
  defaultSkillWeatherForecast,
  defaultSkillLinkPreview,
  defaultSkillConnectIntegration,
  defaultSkillAsk,
  defaultSkillMap,
] as const

/**
 * Monotonic version of the shipped skill defaults. Bump every time
 * `defaultSkills` changes in any way. Reconcile uses this as the ordering
 * signal so multi-device sync groups converge without ping-ponging (THU-637
 * pattern extended to skills in THU-677): a device only overwrites existing
 * rows when this bundled version is strictly newer than the highest ever
 * applied on this account.
 *
 * The paired snapshot test in `skills.test.ts` fails on any change to this
 * file's defaults without a matching version bump.
 */
export const defaultSkillsVersion = 3
