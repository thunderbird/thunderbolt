import { getDefaultCloudUrl } from '@/lib/config'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from '../db/singleton'
import { accountsTable, modelsTable, promptsTable, settingsTable, tasksTable } from '../db/tables'

export const seedAccounts = async () => {
  const db = DatabaseSingleton.instance.db
  await db.select().from(accountsTable)
  // if (accounts.length === 0) {
  //   await db.insert(accountsTable).values({
  //     id: uuidv7(),
  //     type: 'imap',
  //     imapHostname: 'imap.thundermail.com',
  //     imapPort: 993,
  //     imapUsername: 'you@tb.pro',
  //     imapPassword: 'password',
  //   })
  // }
}

export const seedModels = async () => {
  const db = DatabaseSingleton.instance.db
  const models = await db.select().from(modelsTable)

  if (models.length === 0) {
    /**
     * Using hardwired IDs to ensure consistency across installs.
     * New items should follow the pattern and have their ID hardwired.
     */
    const seedData = [
      {
        id: '0198ecc5-cc2b-735b-b478-785b85d3c731',
        name: 'Qwen 3',
        provider: 'flower' as const,
        model: 'qwen/qwen3-235b',
        isSystem: 1,
        enabled: 1,
        isConfidential: 1,
        contextWindow: 256000,
        toolUsage: 1,
        tokenizer: 'qwen3',
      },
      {
        id: '0198ecc5-cc2b-735b-b478-7c6770371b84',
        name: 'Qwen 3',
        provider: 'thunderbolt' as const,
        model: 'qwen3-235b-a22b-instruct-2507',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
        contextWindow: 256000,
        tokenizer: 'qwen3',
      },
      {
        id: '0198ecc5-cc2b-735b-b478-80dcfed4ea97',
        name: 'Qwen 3 (Thinking)',
        provider: 'thunderbolt' as const,
        model: 'qwen3-235b-a22b-thinking-2507',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
        startWithReasoning: 1,
        contextWindow: 256000,
        tokenizer: 'qwen3',
      },
    ]
    for (const model of seedData) {
      await db.insert(modelsTable).values(model)
    }
  }
}

export const seedSettings = async () => {
  const db = DatabaseSingleton.instance.db

  await db
    .insert(settingsTable)
    .values({
      key: 'cloud_url',
      value: getDefaultCloudUrl(),
    })
    .onConflictDoNothing()

  await db
    .insert(settingsTable)
    .values({
      key: 'anonymous_id',
      value: uuidv7(), // @todo this should really be cryptographically secure
    })
    .onConflictDoNothing()

  await db
    .insert(settingsTable)
    .values({
      key: 'is_triggers_enabled',
      value: 'false',
    })
    .onConflictDoNothing()

  await db
    .insert(settingsTable)
    .values({
      key: 'disable_flower_encryption',
      value: 'false',
    })
    .onConflictDoNothing()

  await db
    .insert(settingsTable)
    .values({
      key: 'debug_posthog',
      value: 'false',
    })
    .onConflictDoNothing()
}

export const seedTasks = async () => {
  const db = DatabaseSingleton.instance.db
  const existingTasks = await db.select().from(tasksTable).limit(1)

  if (existingTasks.length > 0) {
    return
  }

  /**
   * Using hardwired IDs to ensure consistency across installs.
   * New items should follow the pattern and have their ID hardwired.
   */
  const seedData = [
    {
      id: '0198ecc5-cc2b-735b-b478-93f8db7202ce',
      item: 'Connect your email account to get started',
      order: 100,
      isComplete: 0,
    },
    {
      id: '0198ecc5-cc2b-735b-b478-96071aa92f62',
      item: 'Set your name and location in preferences for better AI responses',
      order: 200,
      isComplete: 0,
    },
    {
      id: '0198ecc5-cc2b-735b-b478-99e9874d61ba',
      item: 'Explore Thunderbolt Pro tools to extend capabilities',
      order: 300,
      isComplete: 0,
    },
  ]

  for (const task of seedData) {
    await db.insert(tasksTable).values(task)
  }
}

export const seedPrompts = async () => {
  const db = DatabaseSingleton.instance.db
  const existingPrompts = await db.select().from(promptsTable).limit(1)

  if (existingPrompts.length > 0) {
    return
  }

  // Get the first system model as default
  const systemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1)).limit(1)
  const defaultModelId = systemModels[0]?.id

  if (!defaultModelId) {
    console.warn('No system model found for seeding prompts')
    return
  }

  /**
   * Using hardwired IDs to ensure consistency across installs.
   * New items should follow the pattern and have their ID hardwired.
   */
  const seedData = [
    {
      id: '0198ecc5-cc2b-735b-b478-9ff7f5b047d3',
      title: 'Daily Brief',
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
      modelId: defaultModelId,
    },
    {
      id: '0198ecc5-cc2b-735b-b478-a17c00778369',
      title: 'Deep Research',
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
      modelId: defaultModelId,
    },
    {
      id: '0198ecc5-cc2b-735b-b478-a61c73ab50d6',
      title: 'Important Emails',
      prompt: `Review my inbox and summarize the 5 most important emails that need my attention today. Include sender, subject, and why each is important.`,
      modelId: defaultModelId,
    },
  ]

  for (const promptData of seedData) {
    await db.insert(promptsTable).values(promptData)
  }
}
