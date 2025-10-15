import { hashValues } from '@/lib/utils'
import type { Prompt } from '@/types'
import { defaultModelQwen3Flower } from './models'

/**
 * Compute hash of user-editable fields for a prompt
 * Includes deletedAt to treat soft-delete as a user configuration choice
 */
export const hashPrompt = (prompt: Prompt): string => {
  return hashValues([prompt.title, prompt.prompt, prompt.modelId, prompt.deletedAt])
}

/**
 * Default automations (prompts) shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 */
export const defaultAutomationDailyBrief: Prompt = {
  id: '0198ecc5-cc2b-735b-b478-9ff7f5b047d3',
  title: 'Daily Brief',
  deletedAt: null,
  defaultHash: null,
  modelId: defaultModelQwen3Flower.id,
  prompt: `Create a daily brief with the following sections. Do not ask me for any missing information - just skip sections for which you are missing information or tools.

1. If you know my location, use the get_weather_forecast tool to check today's weather for my location. I only need to know the weather for today. If not, skip this section.

2. Today's top news stories. Use the fetch_content tool to get the content of apnews.com. Provide the top 10 headlines in an ordered list.

3. If you have access to email tools, check my inbox and give me a summary of what has come on over the last 24 hours, focusing on what looks most important. If not, skip this section.

4. If you access to calendar tools, check my calendar and give me a summary of what is coming up for the current day. Please provide this as a personal assistant might. If not, skip this section.

Please format the brief as follows:

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

Do not show skipped sections at all, even placeholders - just skip them entirely.`,
}

export const defaultAutomationDeepResearch: Prompt = {
  id: '0198ecc5-cc2b-735b-b478-a17c00778369',
  title: 'Deep Research',
  deletedAt: null,
  defaultHash: null,
  modelId: defaultModelQwen3Flower.id,
  prompt: `You are **Deep Research**, an expert analyst who can iteratively SEARCH the web and FETCH full documents.

First, ask the user: "What topic or question would you like me to investigate?"

────────────────────────
BEFORE YOU BEGIN
────────────────────────
1. Clarify the research goal in one sentence.
2. Break the goal into 3–8 sub-questions that must be answered.
3. For each sub-question, draft 1–3 precise search queries
   (include keywords, synonyms, acronyms, date ranges, etc.).

────────────────────────
ITERATIVE RESEARCH LOOP
(repeat until marginal returns are low
 or token budget reaches ~80 %)
────────────────────────
For each sub-question **in priority order**:

1. Call \`search(query)\` with the first drafted query.  
   • If results are scarce or irrelevant, refine the query and retry.  
   • Keep a running list of the 5 most promising result IDs with brief notes
     (publisher, date, relevance).

2. For every promising result:  
   • Call \`fetch(result_id)\` to retrieve the full text.  
   • Skim and extract:  
       – Core claims or data (≤ 5 bullets)  
       – Author credibility signals (affiliation, citations, peer review, conflicts)  
       – Publication date & context  
   • Save each extraction in structured memory:
     \`{sub-question → source # → findings}\`.

3. Cross-check new findings against previous ones.
   Flag contradictions or emerging consensus.

4. Decide whether the sub-question is sufficiently answered.  
   • If **yes**, draft a ≤ 150-word summary, adding parenthetical source numbers  
     (e.g. "A 2024 WHO report indicates … (3)").  
   • If **no**, iterate with a refined or expanded query.

────────────────────────
SYNTHESIS & OUTPUT
────────────────────────
When all sub-questions are resolved or time is nearly up:

1. **Executive Summary** (≤ 250 words)  
   – Direct answer to the original goal  
   – Key insights and confidence rating

2. **Detailed Findings**  
   For each sub-question:  
   – 2- to 3-sentence answer  
   – Bullet list of evidentiary highlights with parenthetical source numbers.

3. **Critical Analysis**  
   – Note conflicting evidence, methodological weaknesses, or gaps  
   – Identify areas needing further primary research.

4. **Source List**  
   Numbered list matching the in-text numbers:  
   \`(1) Title, author, publisher, date, URL or document ID\`  
   \`(2) …\`  
   …

5. **Appendix** (optional)  
   Tables, timelines, or data extracts that aid comprehension.

────────────────────────
RULES & STYLE GUIDELINES
────────────────────────
• Cite sources with simple numbers in parentheses—(1), (2), etc.—
  matching the Source List.  
• Prefer recent, high-authority sources; include at least one
  peer-reviewed or primary document when possible.  
• Avoid speculation; label any hypotheses or low-confidence statements.  
• Write in clear, formal prose using active voice and varied sentence length.

Begin now.`,
}

export const defaultAutomationImportantEmails: Prompt = {
  id: '0198ecc5-cc2b-735b-b478-a61c73ab50d6',
  title: 'Important Emails',
  deletedAt: null,
  defaultHash: null,
  modelId: defaultModelQwen3Flower.id,
  prompt: `Review my inbox and summarize the 5 most important emails that need my attention today. Include sender, subject, and why each is important.`,
}

/**
 * Array of all default automations for iteration
 */
export const defaultAutomations: ReadonlyArray<Prompt> = [
  defaultAutomationDailyBrief,
  defaultAutomationDeepResearch,
  defaultAutomationImportantEmails,
] as const
