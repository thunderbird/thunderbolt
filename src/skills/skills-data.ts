/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type SkillSource = 'marketplace' | 'local'

export type Skill = {
  name: string
  source: SkillSource
  pinned?: boolean
  version?: string
  description: string
  instruction: string
}

const weeklyReviewDescription =
  'Use this skill when the user wants to run a weekly review, reflect on the past week, plan the upcoming week, or process notes and tasks accumulated over the last 7 days. Triggers include phrases like "weekly review," "let\'s plan my week," "what did I get done this week," or "help me reset for Monday." Do not use for daily standups, quarterly planning, or one-off task prioritization.'

const weeklyReviewInstruction = `Walk the user through a weekly review in four passes. Do not skip steps, and do not combine them into one prompt – the value comes from doing each pass cleanly before moving to the next.

1. CAPTURE – Ask what's on their mind from the past week. Surface wins, frustrations, and anything still rattling around. If they paste raw meeting notes, hand them off to /meeting-notes first and bring the structured output back here. Do not interpret yet, just collect.

2. CLEAR – Go through their captured items and sort each into: done, drop, defer, or do-this-week. Be decisive; nudge them away from leaving things in limbo. Once the do-this-week pile is settled, run /tast-triage on it to produce a stack-ranked list.

3. REFLECT – Ask one focused question: what worked this week, and what didn't? Keep the answer to 2-3 sentences total. Long reflection produces less follow-through than short reflection.

4. PLAN – Identify the 3 most important outcomes for next week. Not tasks – outcomes. Tie each one to a specific day if possible.

End with a one-paragraph summary the user can paste into their notes app.`

const meetingNotesDescription =
  'Use this skill when the user shares raw meeting notes, a transcript, or bullets from a recent call and wants them cleaned up, summarized, or turned into action items. Triggers include phrases like "clean up these notes," "summarize this meeting," "what are the action items," or "turn this into a recap." Do not use for live note-taking, drafting an agenda, or unrelated writing tasks.'

const meetingNotesInstruction = `Pull three things out of the notes, in this order. Do not skip any of them.

1. DECISIONS — what was actually decided, in one line each. If a decision was hedged or deferred, mark it as "open" instead.

2. ACTION ITEMS — who does what by when. Always include an owner; if the notes don't name one, ask. If a date is missing, ask.

3. OPEN QUESTIONS — anything that came up but didn't resolve. These are not action items; they're things to bring back next time.

End with one sentence asking whether the user wants help drafting a recap message to send to attendees.`

// A couple of these are marked `source: 'marketplace'` so the source-aware UI
// (badge, version, source filter, uninstall vs delete) has data to render
// against in the shell. Backend will replace `baseSkills` with a per-user fetch.
export const baseSkills: Skill[] = [
  {
    name: '/weekly-review',
    source: 'local',
    pinned: true,
    description: weeklyReviewDescription,
    instruction: weeklyReviewInstruction,
  },
  {
    name: '/meeting-notes',
    source: 'local',
    pinned: true,
    description: meetingNotesDescription,
    instruction: meetingNotesInstruction,
  },
  {
    name: '/tast-triage',
    source: 'marketplace',
    version: '1.0.0',
    description:
      'Use this skill when the user dumps a list of tasks, a backlog, or a to-do brain-dump and wants help prioritizing. Triggers include "what should I work on first," "help me triage this list," "I have too much going on," or "rank these by priority." Do not use for project planning across multiple weeks or for one-off task creation.',
    instruction: `Help the user sort their list using a priority and effort frame. Stay decisive; do not produce a long analysis.

1. ESTIMATE — for each item, infer an effort level (S / M / L) and a priority (high / med / low). Surface anything ambiguous in one short clarifying question.

2. STACK-RANK — produce a single ordered list. High-priority Smalls go first ("quick wins"), then high-priority Mediums, then everything else by priority.

3. CALL OUT — name the top 1-3 items the user should do today, and any items that look like they should be dropped or delegated.

Do not produce sub-tasks unless asked.`,
  },
  {
    name: '/product-design',
    source: 'marketplace',
    version: '1.0.0',
    description:
      'Designing end-to-end user experiences, from understanding user problems and researching user solutions to delivering polished, production-ready interfaces that ship.',
    instruction: `Walk the user through a product design pass in five steps. Don't combine steps; one clean pass per step.

1. PROBLEM. Restate the user problem in one sentence. Surface who the user is, what they're trying to do, and why it's painful today.

2. CONSTRAINTS. List the platform, time, technical, and business constraints that bound the solution space.

3. SKETCH. Propose two or three solution directions at a high level. Note what each is good and bad at.

4. PICK. Recommend one direction. Say what evidence would change your mind.

5. NEXT. Identify the smallest version that can be tested with users this week.

End with a one-paragraph summary the user can share with the team.`,
  },
]
