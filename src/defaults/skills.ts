/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import { officeSkillNames } from '@/office/constants'
import { loadOfficeSkillBody, officeSkillLengths, type OfficeSkillFormat } from '@/office/skills'
import type { Skill, SkillRow } from '@/types'
import { instructions as askWidgetInstruction } from '@/widgets/ask/instructions'
import { instructions as connectIntegrationWidgetInstruction } from '@/widgets/connect-integration/instructions'
import { instructions as linkPreviewWidgetInstruction } from '@/widgets/link-preview/instructions'
import { instructions as mapWidgetInstruction } from '@/widgets/map/instructions'
import { instructions as weatherForecastWidgetInstruction } from '@/widgets/weather-forecast/instructions'

/**
 * Hash of reconciled skill fields. Contract skills hash only their locked
 * content so enabled or legacy pinned state cannot block contract updates.
 * Editable task defaults also include state and `deletedAt`, so those user
 * changes remain protected from reconciliation.
 *
 * Accepts raw (nullable) rows as well as `Skill` so the hash-restamp data
 * migration can stamp exactly what reconciliation will later recompute.
 */
export const hashSkill = (
  skill: Pick<
    SkillRow,
    'id' | 'name' | 'label' | 'description' | 'instruction' | 'enabled' | 'pinnedOrder' | 'deletedAt'
  >,
): string => {
  const contentFields = [skill.name, skill.label, skill.description, skill.instruction]
  return hashValues(
    isContractSkillId(skill.id) ? contentFields : [...contentFields, skill.enabled, skill.pinnedOrder, skill.deletedAt],
  )
}

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

/** Default search skill (`/search`). */
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

/** Default research skill (`/research`). */
const researchInstruction = `You are **Deep Research**. Investigate the requested question thoroughly using primary evidence.

## Current-turn budget
The web budget counts combined search and fetch_content calls, not sources. Research has an absolute ceiling of 30 web calls; the available cap may be smaller and calls already used still count. Repeated skill loads do not add another allowance. Plan within the remaining budget rather than trying to satisfy a fixed search or page-fetch quota.

If the current turn reports exhaustion, stop web calls and synthesize from available evidence and remaining non-web tools. A later explicit capacity-restored instruction supersedes that stop. Historical exhaustion from an earlier turn does not exhaust a new turn. Disclose uncovered requirements and unsupported claims; never invent evidence or claim exhaustive coverage merely because the budget ran out.

A new user turn starts with a fresh ordinary budget. If that new request needs research, load this skill again; instructions inherited from conversation history alone neither grant more web calls nor forbid another load.

## Plan and investigate
- Identify the requested dimensions and break them into focused sub-questions.
- Allocate the available calls across all requested entities and dimensions before deep-diving into any one; use varied queries and primary sources.
- Use a sufficient search snippet directly. Fetch a page when its full text is needed to support a claim, resolve a conflict, or fill a material gap.
- Reuse cached results and their source IDs instead of repeating identical calls.
- Continue until the requested coverage is supported or the available budget is exhausted; do not add calls merely to fill a quota.

## Output
Verify each material number and quote against its cited source, preserve qualifiers, and omit unsupported asides.
1. **Executive Summary** — Direct answer with an appropriate confidence level.
2. **Detailed Findings** — Organized by sub-question, with inline [N] citations for sourced claims.
3. **Conflicts & Gaps** — Explain disagreements, missing evidence and what could not be verified.
Do not add a Sources or References section; inline citations are sufficient.`

/**
 * Default skills seeded for new users on first sign-in. UUIDs are stable so
 * the reconciler can recognize them across devices and across app restarts.
 *
 * New users get Search, Research, and Weather pinned (in that order) as their
 * starter chips; Daily Brief ships enabled but unpinned, and Important Emails
 * ships disabled. Additional model-facing widget contracts and the Office
 * format skills ship enabled and unpinned. Task skills may be edited or
 * soft-deleted; contract skills only expose enabled state.
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
  instruction: weatherForecastWidgetInstruction,
  enabled: 1,
  pinnedOrder: 2,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillLinkPreview: Skill = {
  id: '01996330-0000-7000-8000-000000000006',
  name: 'link-preview',
  label: 'Link Preview',
  description:
    'Use this skill when the user wants web results, news, products, recommendations, or other fetched pages shown as rich link previews.',
  instruction: linkPreviewWidgetInstruction,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillConnectIntegration: Skill = {
  id: '01996330-0000-7000-8000-000000000007',
  name: 'connect-integration',
  label: 'Connect Integration',
  description:
    'Use this skill when the user asks to access email or calendar but required Google or Microsoft tools are unavailable.',
  instruction: connectIntegrationWidgetInstruction,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillAsk: Skill = {
  id: '01996330-0000-7000-8000-000000000008',
  name: 'ask',
  label: 'Ask',
  description: 'Use this skill when asking the user to choose from options or answer an interactive quiz prompt.',
  instruction: askWidgetInstruction,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillMap: Skill = {
  id: '01996330-0000-7000-8000-000000000009',
  name: 'map',
  label: 'Map',
  description:
    'Use this skill when the user asks to see locations, routes, regions, or other geographic results on an interactive map.',
  instruction: mapWidgetInstruction,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

/**
 * The whole `instruction` of an Office row. Builds older than the Office tool get these rows through sync but have no
 * `run_office_script`, so the row says only what is true there, also for an external agent that can write the file
 * with its own tools. A build with the tool serves its own manual through {@link officeSkillManual}, so the text always
 * matches the sandbox it runs in.
 */
const officeSkillStub =
  'If run_office_script is not one of your tools, this version of the app cannot run it. Create the file with your own tools if you have them; otherwise tell the user to update the app to create or edit Word, Excel or PowerPoint files.'

export const defaultSkillOfficeDocx: Skill = {
  id: '01996330-0000-7000-8000-000000000010',
  name: officeSkillNames.docx,
  label: 'Word documents',
  description:
    'Load before using run_office_script to create or edit a Word document (.docx), including an attached template.',
  instruction: officeSkillStub,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillOfficeXlsx: Skill = {
  id: '01996330-0000-7000-8000-000000000011',
  name: officeSkillNames.xlsx,
  label: 'Excel workbooks',
  description:
    'Load before using run_office_script to create or edit an Excel workbook (.xlsx or .xlsm), including formulas, charts and conditional formatting.',
  instruction: officeSkillStub,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillOfficePptx: Skill = {
  id: '01996330-0000-7000-8000-000000000012',
  name: officeSkillNames.pptx,
  label: 'PowerPoint presentations',
  description:
    'Load before using run_office_script to create or edit a PowerPoint deck (.pptx), including slide layouts, animations and transitions.',
  instruction: officeSkillStub,
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const widgetSkillIds = new Set([
  defaultSkillWeather.id,
  defaultSkillLinkPreview.id,
  defaultSkillConnectIntegration.id,
  defaultSkillAsk.id,
  defaultSkillMap.id,
])

/** The Office format whose manual this build serves for each Office row, by stable id. Changing a manual needs no
 *  `defaultSkillsVersion` bump. */
const officeSkillFormats = new Map<string, OfficeSkillFormat>([
  [defaultSkillOfficeDocx.id, 'docx'],
  [defaultSkillOfficeXlsx.id, 'xlsx'],
  [defaultSkillOfficePptx.id, 'pptx'],
])

/** Whether a skill id belongs to a model-facing widget rendering contract. */
export const isWidgetSkillId = (id: string): boolean => widgetSkillIds.has(id)

/** Whether a skill id is an Office format skill, which only a request with `run_office_script` may offer. */
export const isOfficeSkillId = (id: string): boolean => officeSkillFormats.has(id)

/**
 * An Office row's manual from this build, which the row only stubs, or undefined for any other row. It loads from its
 * own chunk on first use, so it stays out of the entry bundle and out of every request that does not use it. The
 * promise is the same on every call, which React's `use()` can read.
 */
export const officeSkillManual = (id: string): Promise<string> | undefined => {
  const format = officeSkillFormats.get(id)
  return format ? loadOfficeSkillBody(format) : undefined
}

/**
 * The instructions a skill gives the model and the user on this build: an Office row's manual, and any other row's
 * own `instruction`.
 */
export const skillInstruction = async (skill: Pick<Skill, 'id' | 'instruction'>): Promise<string> =>
  officeSkillManual(skill.id) ?? skill.instruction

/** The length of {@link skillInstruction}'s text, known without loading an Office manual. */
export const skillInstructionLength = (skill: Pick<Skill, 'id' | 'instruction'>): number => {
  const format = officeSkillFormats.get(skill.id)
  return format ? officeSkillLengths[format] : skill.instruction.length
}

/**
 * The skills without any row that shares a name with an Office row, which then answers to that name alone. Names are
 * not unique in the table: a row created on a build without the Office skills, or a reconcile insert, skips the
 * DAL's name check, and name lookups take the first or last match.
 */
export const withoutOfficeNameClashes = <T extends Pick<Skill, 'id' | 'name'>>(skills: readonly T[]): T[] => {
  const officeNames = new Set(skills.filter(({ id }) => isOfficeSkillId(id)).map(({ name }) => name))
  return skills.filter(({ id, name }) => isOfficeSkillId(id) || !officeNames.has(name))
}

/**
 * Whether a skill id is a shipped, read-only contract: a widget rendering contract or an Office format skill. Its
 * content is locked and reconciled; the user may only toggle it.
 */
export const isContractSkillId = (id: string): boolean => isWidgetSkillId(id) || isOfficeSkillId(id)

export const defaultSkills: ReadonlyArray<Skill> = [
  defaultSkillDailyBrief,
  defaultSkillImportantEmails,
  defaultSkillSearch,
  defaultSkillResearch,
  defaultSkillWeather,
  defaultSkillLinkPreview,
  defaultSkillConnectIntegration,
  defaultSkillAsk,
  defaultSkillMap,
  defaultSkillOfficeDocx,
  defaultSkillOfficeXlsx,
  defaultSkillOfficePptx,
] as const

/**
 * Monotonic version of the shipped skill defaults. Bump every time
 * `defaultSkills` changes in any way. Reconcile uses this as the ordering
 * signal so multi-device sync groups converge without ping-ponging:
 * a device only overwrites existing
 * rows when this bundled version is strictly newer than the highest ever
 * applied on this account.
 *
 * The paired snapshot test in `skills.test.ts` fails on any change to this
 * file's defaults without a matching version bump.
 */
export const defaultSkillsVersion = 10
