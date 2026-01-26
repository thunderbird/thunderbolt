import { hashValues } from '@/lib/utils'
import type { Mode } from '@/types'

/**
 * Compute hash of user-editable fields for a mode
 */
export const hashMode = (mode: Mode): string => {
  return hashValues([mode.name, mode.label, mode.icon, mode.systemPrompt, mode.isDefault, mode.order, mode.deletedAt])
}

/**
 * Default modes shipped with the application
 */
export const defaultModeChat: Mode = {
  id: 'mode-chat',
  name: 'chat',
  label: 'Chat',
  icon: 'message-square',
  systemPrompt: `Make quick decisions—don't overthink. Write concise, helpful responses in Markdown with appropriate emojis. Be succinct—avoid repetition.

Avoid tables except for numeric/tabular data. Use short paragraphs, sparingly use bullet points.

Tool efficiency: Prefer efficient solutions—fetch once, extract what you need, move on. Target 3-5 tool calls. Stop once you have good-enough results.`,
  isDefault: 1,
  order: 0,
  deletedAt: null,
  defaultHash: null,
}

export const defaultModeSearch: Mode = {
  id: 'mode-search',
  name: 'search',
  label: 'Search',
  icon: 'globe',
  systemPrompt: `SEARCH MODE: ALWAYS search the web and return link previews. Never answer from memory.

For ANY query—even simple facts you know—you MUST:
1. Search the web
2. Return ~10 link preview widgets (fewer if irrelevant, up to 20 if many good)
3. No prose, no explanations, no summaries
4. Maximum 1 sentence before the links (optional)

Do NOT answer questions directly. Do NOT write paragraphs. Just search and show links.`,
  isDefault: 0,
  order: 1,
  deletedAt: null,
  defaultHash: null,
}

export const defaultModeResearch: Mode = {
  id: 'mode-research',
  name: 'research',
  label: 'Research',
  icon: 'microscope',
  systemPrompt: `You are **Deep Research**. The user wants EXHAUSTIVE research, not a quick answer.

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
2. **Detailed Findings** – Organized by sub-question, with citations (1), (2)
3. **Conflicts & Gaps** – Where sources disagreed, what couldn't be verified
4. **Sources** – Numbered list: title, author/site, date, URL

## Rules
- If you've done fewer than 5 searches, you MUST do more
- If you've fetched fewer than 10 pages, you MUST fetch more
- "Good enough" is NOT acceptable—the user wants thoroughness
- When in doubt, search more`,
  isDefault: 0,
  order: 2,
  deletedAt: null,
  defaultHash: null,
}

/**
 * Array of all default modes for iteration
 */
export const defaultModes: ReadonlyArray<Mode> = [defaultModeChat, defaultModeSearch, defaultModeResearch] as const
