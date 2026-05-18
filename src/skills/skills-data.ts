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
]
