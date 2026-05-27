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

const meetingNotesInstruction = `Pull three things out of the notes, in this order. Do not skip any of them.

1. DECISIONS — what was actually decided, in one line each. If a decision was hedged or deferred, mark it as "open" instead.

2. ACTION ITEMS — who does what by when. Always include an owner; if the notes don't name one, ask. If a date is missing, ask.

3. OPEN QUESTIONS — anything that came up but didn't resolve. These are not action items; they're things to bring back next time.

End with one sentence asking whether the user wants help drafting a recap message to send to attendees.`

const weeklyReviewInstruction = `Walk the user through a weekly review in four passes. Do not skip steps, and do not combine them into one prompt — the value comes from doing each pass cleanly before moving to the next.

1. CAPTURE — Ask what's on their mind from the past week. Surface wins, frustrations, and anything still rattling around. Do not interpret yet, just collect.

2. CLEAR — Go through their captured items and sort each into: done, drop, defer, or do-this-week. Be decisive; nudge them away from leaving things in limbo.

3. REFLECT — Ask one focused question: what worked this week, and what didn't? Keep the answer to 2-3 sentences total. Long reflection produces less follow-through than short reflection.

4. PLAN — Identify the 3 most important outcomes for next week. Not tasks — outcomes. Tie each one to a specific day if possible.

End with a one-paragraph summary the user can paste into their notes app.`

const taskTriageInstruction = `Help the user sort a list of tasks using a priority and effort frame. Stay decisive; do not produce a long analysis.

1. ESTIMATE — for each item, infer an effort level (S / M / L) and a priority (high / med / low). Surface anything ambiguous in one short clarifying question.

2. STACK-RANK — produce a single ordered list. High-priority Smalls go first ("quick wins"), then high-priority Mediums, then everything else by priority.

3. CALL OUT — name the top 1-3 items the user should do today, and any items that look like they should be dropped or delegated.

Do not produce sub-tasks unless asked.`

/**
 * Default skills seeded for new users on first sign-in. UUIDs are stable so
 * the reconciler can recognize them across devices and across app restarts.
 * Each lands enabled and pinned in the order listed; a user who soft-deletes
 * one will not see it re-seeded.
 */
export const defaultSkillMeetingNotes: Skill = {
  id: '01996330-0000-7000-8000-000000000001',
  name: 'meeting-notes',
  description:
    'Use this skill when the user shares raw meeting notes, a transcript, or bullets from a recent call and wants them cleaned up, summarized, or turned into action items.',
  instruction: meetingNotesInstruction,
  enabled: 1,
  pinnedOrder: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillWeeklyReview: Skill = {
  id: '01996330-0000-7000-8000-000000000002',
  name: 'weekly-review',
  description:
    'Use this skill when the user wants to run a weekly review, reflect on the past week, plan the upcoming week, or process notes and tasks accumulated over the last 7 days.',
  instruction: weeklyReviewInstruction,
  enabled: 1,
  pinnedOrder: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkillTaskTriage: Skill = {
  id: '01996330-0000-7000-8000-000000000003',
  name: 'task-triage',
  description:
    'Use this skill when the user dumps a list of tasks, a backlog, or a to-do brain-dump and wants help prioritizing.',
  instruction: taskTriageInstruction,
  enabled: 1,
  pinnedOrder: 2,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSkills: ReadonlyArray<Skill> = [
  defaultSkillMeetingNotes,
  defaultSkillWeeklyReview,
  defaultSkillTaskTriage,
] as const
