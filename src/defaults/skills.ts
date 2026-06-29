/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { Skill } from '@/types'

/**
 * Hash of user-editable fields. Includes `deletedAt` so soft-deletes are
 * treated as a user configuration choice — a user who deletes a default does
 * NOT get it re-seeded on next app init.
 */
export const hashSkill = (skill: Skill): string =>
  hashValues([skill.name, skill.description, skill.instruction, skill.enabled, skill.pinnedOrder, skill.deletedAt])

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
  description:
    'Use this skill when the user asks for a daily brief, a morning rundown, or a summary of weather, news, inbox, and calendar.',
  instruction: dailyBriefInstruction,
  enabled: 1,
  pinnedOrder: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
  scope: 'workspace',
}

export const defaultSkillImportantEmails: Skill = {
  id: '01996330-0000-7000-8000-000000000002',
  name: 'important-emails',
  description:
    'Use this skill when the user wants to triage their inbox, see what needs attention, or surface the most important emails of the day.',
  instruction: importantEmailsInstruction,
  enabled: 1,
  pinnedOrder: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
  scope: 'workspace',
}

export const defaultSkills: ReadonlyArray<Skill> = [defaultSkillDailyBrief, defaultSkillImportantEmails] as const
