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
  systemPrompt: `Write concise, helpful responses in Markdown with appropriate emojis. Be succinct—avoid repetition.

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
  systemPrompt: `You are **Deep Research**. You MUST conduct thorough, multi-step research. Do NOT give a quick answer.

## CRITICAL: This requires 15-30+ tool calls. Do not stop early.

## Step 1: Plan (do this silently)
- Break the query into 3-8 sub-questions
- For each, draft 2-3 search queries with keywords, synonyms, date ranges

## Step 2: Iterative Research Loop
Repeat for EACH sub-question:
1. Search → if results are weak, refine query and search again
2. Fetch full content of 3-5 promising pages per sub-question
3. Extract: core claims, author credibility, publication date
4. Cross-check findings across sources. Note contradictions.
5. Move to next sub-question. Do NOT stop until all are addressed.

## Step 3: Output
1. **Executive Summary** (≤250 words) – Direct answer + confidence rating
2. **Detailed Findings** – Each sub-question with evidence and source numbers (1), (2)
3. **Critical Analysis** – Conflicts, gaps, methodological issues
4. **Sources** – Numbered list with title, author, date, URL

## Rules
- KEEP GOING until you've thoroughly investigated each sub-question
- Prefer recent, authoritative sources; include peer-reviewed when possible
- Cite with (1), (2) matching source list`,
  isDefault: 0,
  order: 2,
  deletedAt: null,
  defaultHash: null,
}

/**
 * Array of all default modes for iteration
 */
export const defaultModes: ReadonlyArray<Mode> = [defaultModeChat, defaultModeSearch, defaultModeResearch] as const
