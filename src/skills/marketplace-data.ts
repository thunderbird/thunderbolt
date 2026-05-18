/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Skill } from './skills-data'

export type Card = {
  name: string
  author: string
  downloads: string
  description: string
  instruction: string
  installed: boolean
}

export const cards: Card[] = [
  {
    name: '/tast-triage',
    author: 'Henry Caldwell',
    downloads: '412,738',
    description:
      'Use this skill when the user dumps a list of tasks, a backlog, or a to-do brain-dump and wants help prioritizing. Triggers include "what should I work on first," "help me triage this list," "I have too much going on," or "rank these by priority." Do not use for project planning across multiple weeks or for one-off task creation.',
    instruction: `Help the user sort their list using a priority and effort frame. Stay decisive; do not produce a long analysis.

1. ESTIMATE — for each item, infer an effort level (S / M / L) and a priority (high / med / low). Surface anything ambiguous in one short clarifying question.

2. STACK-RANK — produce a single ordered list. High-priority Smalls go first ("quick wins"), then high-priority Mediums, then everything else by priority.

3. CALL OUT — name the top 1-3 items the user should do today, and any items that look like they should be dropped or delegated.

Do not produce sub-tasks unless asked.`,
    installed: true,
  },
  {
    name: '/product-design',
    author: 'Mozilla',
    downloads: '1,356,790',
    description:
      'Designing end-to-end user experiences, from understanding user problems and researching user solutions to delivering polished, production-ready interfaces that ship.',
    instruction: `Walk the user through a product design pass in five steps. Don't combine steps; one clean pass per step.

1. PROBLEM. Restate the user problem in one sentence. Surface who the user is, what they're trying to do, and why it's painful today.

2. CONSTRAINTS. List the platform, time, technical, and business constraints that bound the solution space.

3. SKETCH. Propose two or three solution directions at a high level. Note what each is good and bad at.

4. PICK. Recommend one direction. Say what evidence would change your mind.

5. NEXT. Identify the smallest version that can be tested with users this week.

End with a one-paragraph summary the user can share with the team.`,
    installed: true,
  },
  {
    name: '/ui-design',
    author: 'Eleanor Whitfield',
    downloads: '678,902',
    description:
      'Crafting clean, intuitive interfaces with careful attention to spacing, hierarchy, and visual detail so every screen feels considered and easy to use.',
    instruction: `Critique or design a UI in four passes. Be concrete. Reference pixels, tokens, and components, not vibes.

1. PURPOSE. State what this screen has to do for the user, and what action it should make obvious.

2. HIERARCHY. Walk top to bottom. Confirm the primary action stands out, secondary actions defer, and dead weight is removed.

3. RHYTHM. Audit spacing, alignment, and font sizes against the design system tokens. Flag anything off-grid or inconsistent.

4. EDGE CASES. Cover empty, loading, error, and overflow states for every key element.

End with a prioritized list of changes, ordered by impact on usability.`,
    installed: true,
  },
  {
    name: '/product-strategy',
    author: 'Marcus Chen',
    downloads: '232,639',
    description:
      'Defining product direction by aligning user needs, business goals, and technical feasibility, then translating that vision into a roadmap that delivers measurable impact over time.',
    instruction: `Build or stress-test a product strategy in four passes.

1. WIN CONDITION. What does success look like 12 months out? Pick one or two measurable outcomes the team will be judged on.

2. WEDGE. Which user, which job, which moment is the wedge into the market? Be specific enough that you could name three real people.

3. MOAT. What gets harder for competitors to copy as you grow? If nothing does, name the risk.

4. BETS. List the three to five bets the roadmap is making, ordered by leverage. For each bet, name what would make it fail.

End with a single paragraph the leadership team could read aloud and agree to.`,
    installed: true,
  },
  {
    name: '/go-to-market',
    author: 'Sofia Almeida',
    downloads: '96,541',
    description:
      'Partnering with marketing, sales, and leadership to plan and execute product launches, ensuring the right messaging, positioning, and rollout strategy reach the target audience.',
    instruction: `Plan a go-to-market motion in five passes.

1. AUDIENCE. Name the segment, the buyer, and the user. They are often not the same person.

2. PROMISE. Write the one-sentence value promise in the user's words, not yours.

3. PROOF. List the three pieces of evidence (case study, benchmark, demo, etc.) that make the promise credible.

4. CHANNELS. Pick the two channels with the best fit between audience attention and message format. Skip the rest.

5. SEQUENCE. Lay out a four-week launch arc: tease, launch, amplify, follow up. Name the owner for each phase.

End with a checklist of artifacts to produce before launch day.`,
    installed: false,
  },
  {
    name: '/growth',
    author: 'James Holloway',
    downloads: '891,427',
    description:
      'Identifying opportunities to drive acquisition, activation, and retention through data-informed experiments, optimizing funnels and product surfaces to move the metrics that matter most.',
    instruction: `Run a growth diagnostic in four passes.

1. METRIC. Confirm the north-star metric and the input metrics that move it. Reject vanity metrics.

2. FUNNEL. Map the current acquisition, activation, and retention funnel with real numbers at each step. Highlight the worst-converting step.

3. HYPOTHESES. Propose three to five experiments that could move that step. Score each by reach, impact, confidence, and effort.

4. PLAN. Pick the top two to run this cycle. Define the metric, the duration, and the decision rule for each.

End with a one-paragraph summary of the bet and how you'll know it worked.`,
    installed: false,
  },
  {
    name: '/metrics-and-analytics',
    author: 'Priya Raman',
    downloads: '29,612',
    description:
      'Defining KPIs, tracking user behavior, and using data to validate hypotheses, measure success, and inform decisions rather than relying on intuition alone.',
    instruction: `Set up a measurement pass in four steps.

1. QUESTION. State the decision the data will inform. If there isn't a decision pending, stop and pick a different question.

2. METRIC. Choose a single primary metric, a guardrail metric, and an early-signal metric. Define each in plain language.

3. INSTRUMENTATION. List the events, properties, and dashboards needed. Flag anything that requires engineering work.

4. THRESHOLDS. Pre-commit to what counts as a win, a flat result, and a regression before you see the data.

End with a one-paragraph plan, including who owns the dashboard and the review cadence.`,
    installed: false,
  },
  {
    name: '/a-b-testing',
    author: 'Oliver Bennett',
    downloads: '203,856',
    description:
      'Designing and running experiments to test ideas with real users, interpreting results carefully, and using findings to ship the version that genuinely performs better.',
    instruction: `Design an A/B test in five steps. Resist shipping before the data is in.

1. HYPOTHESIS. Write it as: "If we change X, then Y will happen because Z."

2. METRIC. Pick the primary metric the test is judged on. Pick guardrails so a win on one axis doesn't tank another.

3. POWER. Estimate the sample size needed for a meaningful effect. If the audience is too small, propose a bigger change instead.

4. VARIANTS. Limit to control plus one or two clearly different variants. Note what each variant is testing about the hypothesis.

5. DECISION RULE. Decide before launch what result will ship, kill, or iterate.

End with a one-paragraph test plan that the analyst and the engineer can both work from.`,
    installed: false,
  },
  {
    name: '/customer-discovery',
    author: 'Clara Voss',
    downloads: '2,156',
    description:
      'Talking to users and prospects to understand their problems, jobs to be done, and willingness to pay, ensuring the product solves real pain points worth paying for.',
    instruction: `Run a customer discovery interview prep in four passes.

1. WHO. Define the segment, role, and recent behavior of the people you want to talk to. Name three real candidates if possible.

2. JOB. State the job-to-be-done you're trying to learn about. Avoid asking about your product.

3. QUESTIONS. Draft five open-ended questions about past behavior, not future intentions. Lead with stories, not opinions.

4. SIGNALS. Decide ahead of time what you'd hear that would confirm or refute your assumption.

End with a one-paragraph debrief template the user can fill in after each interview.`,
    installed: false,
  },
  {
    name: '/market-research',
    author: 'Daniel Okafor',
    downloads: '389,155',
    description:
      'Studying competitors, industry trends, and market gaps to identify opportunities, sharpen positioning, and make informed bets on where to invest product effort.',
    instruction: `Produce a market scan in four passes.

1. SCOPE. Define the market: who's in it, what problem connects them, and where the boundaries are. Reject "everyone."

2. PLAYERS. List the top three to five players. For each, capture their wedge, audience, and weakness in one sentence.

3. TRENDS. Identify two or three shifts (technology, behavior, regulation) that are reshaping the market in the next 12 to 24 months.

4. GAP. Point to the unserved or under-served job that the user could credibly claim.

End with a one-paragraph thesis on where to play and how to win.`,
    installed: false,
  },
  {
    name: '/stakeholder-management',
    author: 'Isabel Moreno',
    downloads: '18,475',
    description:
      'Communicating with founders, executives, investors, and cross-functional partners, building alignment around priorities and keeping everyone informed on progress and tradeoffs.',
    instruction: `Prep a stakeholder communication in four passes.

1. AUDIENCE. Name the stakeholder, what they care about, and what decision (if any) they need to make.

2. ASK. State the one thing you want them to do or know. If you don't have one, the meeting is premature.

3. CONTEXT. Sketch the three to five facts they need to evaluate the ask. Anticipate the obvious objection.

4. FORMAT. Match the channel to the urgency and complexity. Memo for nuanced, Slack for simple, meeting only if discussion is required.

End with a one-paragraph draft they can read in under 60 seconds.`,
    installed: false,
  },
  {
    name: '/prioritization',
    author: 'Henry Caldwell',
    downloads: '1,024,583',
    description:
      'Ranking opportunities and features based on impact, effort, and strategic fit, saying no to good ideas so the team can focus on the great ones that move the business forward.',
    instruction: `Prioritize a backlog in four passes.

1. GOAL. Restate the single outcome this cycle is trying to move. Anything that doesn't trace to it is a candidate to cut.

2. SCORE. For each item, score impact, confidence, and effort on a 1 to 5 scale. Capture a one-line rationale per score.

3. SORT. Order by impact times confidence, divided by effort. Read the top of the list out loud and ask: would I bet a quarter on this?

4. CUT. Move at least 30% of the backlog to "not now." Be visible about the cut so the team trusts the prioritization.

End with a paragraph that explains the chosen top three and what was deliberately deprioritized.`,
    installed: false,
  },
  {
    name: '/meeting-notes',
    author: 'Yuki Tanaka',
    downloads: '267,431',
    description:
      "Capturing what actually happened in a meeting, separating decisions from discussion, and producing notes that travel well to people who weren't in the room.",
    instruction: `Turn a meeting transcript or rough notes into structured notes in four passes.

1. CONTEXT. One sentence on who was there, when, and what the meeting was for.

2. DECISIONS. List the decisions made. Each as a single sentence, in the past tense.

3. ACTIONS. List action items. Each must have an owner and a due date. If either is missing, flag it.

4. OPEN QUESTIONS. List anything unresolved that needs a follow-up, with a name attached.

End with a TL;DR of three to five bullets that someone who skipped the meeting can absorb in 30 seconds.`,
    installed: false,
  },
]

export const defaultInstalledNames = new Set(cards.filter((c) => c.installed).map((c) => c.name))

export const cardToSkill = (card: Card): Skill => ({
  name: card.name,
  source: 'marketplace',
  version: '1.0.0',
  description: card.description,
  instruction: card.instruction,
})
