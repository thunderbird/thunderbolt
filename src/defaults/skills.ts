/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { Skill, SkillRow } from '@/types'

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

/** Former "Search" chat mode, now shipped as a default skill (`/search`). */
const searchInstruction = `SEARCH MODE: ALWAYS search the web and return link previews. Never answer from memory.

For ANY query—even simple facts you know—you MUST:
1. Search the web
2. Evaluate the search results:
   - If results are already individual pages (articles, products, places, etc), use them directly
   - If results are homepages or aggregate pages (/, /hub/, /sections/, listicles), follow the Link Preview Workflow to discover individual URLs
3. Return each result as: <widget:link-preview source="N" url="https://..." />
4. Target ~10 link previews (fewer if irrelevant, up to 20 if many good)
5. No prose, no explanations, no summaries

CRITICAL QUALITY RULES:
- Every link-preview URL must be unique — never repeat the same URL
- Every URL must point to a specific page (deep path), not a homepage or section page
- If search results are all homepages (common for broad news queries), you MUST fetch them to find individual article URLs

Do NOT answer questions directly. Do NOT write paragraphs. Just search and show links.`

const weatherInstruction = `Show the user the weather forecast.

1. Determine the location: use the location from the user's message if given, otherwise use the user's known location. If you have neither, ask.
2. Render the forecast widget: <widget:weather-forecast location="City" region="State" country="Country" />

The widget fetches data automatically — do NOT search the web for weather data. Add at most one short sentence of context; the widget carries the content.`

/** Former "Research" chat mode, now shipped as a default skill (`/research`). */
const researchInstruction = `You are **Deep Research**. The user wants EXHAUSTIVE research, not a quick answer.

## MANDATORY MINIMUMS (non-negotiable)
- At least 5 different searches (different queries, not refinements)
- At least 10 page fetches total
- At least 3 sub-questions investigated
- Do NOT write your final response until you've met these minimums

## Step 1: Plan
Break the query into 3-6 sub-questions. For each, plan 2-3 search queries using different keywords/angles.

## Step 2: Research Loop
For EACH sub-question:
1. Search with your first query
2. Fetch 2-4 promising pages from results
3. Search again with a different angle/query
4. Fetch 2-3 more pages
5. If findings conflict or gaps remain, search again

AFTER completing a sub-question, move to the next. Do NOT skip sub-questions. Do NOT stop early because you "have enough."

## Step 3: Output (only after meeting minimums)
1. **Executive Summary** – Direct answer + confidence level (High/Medium/Low)
2. **Detailed Findings** – Organized by sub-question. Cite with [N] at end of sentence.
3. **Conflicts & Gaps** – Where sources disagreed, what couldn't be verified
Do not add a Sources or References section at the end — inline [N] citations are sufficient.

## Rules
- If you've done fewer than 5 searches, you MUST do more
- If you've fetched fewer than 10 pages, you MUST fetch more
- "Good enough" is NOT acceptable—the user wants thoroughness
- When in doubt, search more`

/**
 * Default skills seeded for new users on first sign-in. UUIDs are stable so
 * the reconciler can recognize them across devices and across app restarts.
 *
 * New users get Search, Research, and Weather pinned (in that order) as their
 * starter chips; Daily Brief ships enabled but unpinned, and Important Emails
 * ships disabled. A user who soft-deletes one will not see it re-seeded.
 */
export const defaultSkillDailyBrief: Skill = {
  id: '01996330-0000-7000-8000-000000000001',
  name: 'daily-brief',
  label: 'Daily Brief',
  description:
    'Use this skill when the user asks for a daily brief, a morning rundown, or a summary of weather, news, inbox, and calendar.',
  instruction: dailyBriefInstruction,
  enabled: 1,
  pinnedOrder: null,
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
  enabled: 0,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillSearch: Skill = {
  id: '01996330-0000-7000-8000-000000000003',
  name: 'search',
  label: 'Search',
  description:
    'Use this skill when the user wants web search results as link previews — current events, products, places, or anything best answered with a list of sources.',
  instruction: searchInstruction,
  enabled: 1,
  pinnedOrder: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillResearch: Skill = {
  id: '01996330-0000-7000-8000-000000000004',
  name: 'research',
  label: 'Research',
  description:
    'Use this skill when the user wants an exhaustive, multi-source deep dive on a topic rather than a quick answer.',
  instruction: researchInstruction,
  enabled: 1,
  pinnedOrder: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillWeather: Skill = {
  id: '01996330-0000-7000-8000-000000000005',
  name: 'weather',
  label: 'Weather',
  description: 'Use this skill when the user asks about the weather or wants a forecast for a location.',
  instruction: weatherInstruction,
  enabled: 1,
  pinnedOrder: 2,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkills: ReadonlyArray<Skill> = [
  defaultSkillDailyBrief,
  defaultSkillImportantEmails,
  defaultSkillSearch,
  defaultSkillResearch,
  defaultSkillWeather,
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
export const defaultSkillsVersion = 4
