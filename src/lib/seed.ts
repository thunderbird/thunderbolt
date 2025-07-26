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
    const seedData = [
      {
        id: uuidv7(),
        name: 'Qwen 3',
        provider: 'thunderbolt' as const,
        model: 'qwen3-235b-a22b-instruct-2507',
        isSystem: 1,
        enabled: 1,
        isConfidential: 0,
      },
      {
        id: uuidv7(),
        name: 'Kimi K2',
        provider: 'thunderbolt' as const,
        model: 'kimi-k2-instruct',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
      },
      {
        id: uuidv7(),
        name: 'DeepSeek R1 0528',
        provider: 'thunderbolt' as const,
        model: 'deepseek-r1-0528',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
      },
      {
        id: uuidv7(),
        name: 'Llama 3.1 405B',
        provider: 'thunderbolt' as const,
        model: 'llama-v3p1-405b-instruct',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
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
}

export const seedTasks = async () => {
  const db = DatabaseSingleton.instance.db
  const existingTasks = await db.select().from(tasksTable).limit(1)

  if (existingTasks.length > 0) {
    return
  }

  const seedData = [
    {
      id: uuidv7(),
      item: 'Connect your email account to get started',
      order: 100,
      isComplete: 0,
    },
    {
      id: uuidv7(),
      item: 'Set your name and location in preferences for better AI responses',
      order: 200,
      isComplete: 0,
    },
    {
      id: uuidv7(),
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

  const seedData = [
    {
      id: uuidv7(),
      title: 'Daily Brief',
      prompt: `Create a daily brief with the following sections. Do not ask me for any missing information - just skip sections for which you are missing information or tools.

1. Today's top news stories. Use the fetch_content tool to get the content of apnews.com. Provide the top 10 headlines in an ordered list.

2. If you know my location, use the get_weather_forecast tool to check today's weather for my location. I only need to know the weather for today. If not, skip this section.

3. If you have access to email tools, check my inbox and tell me the 10 most important items that I should be aware of. If not, skip this section.

Please format the brief as follows:

Good <morning/afternoon/evening> <user's name if available>,

Some friendly, witty variation of "I've put together a daily brief for you!" with an emoji.

# News

1. <headline>
2. <headline>
3. <headline>

# Weather

Today's forecast is ____.

# Inbox

1. <subject line> [From: <person's name>]
2. <subject line> [From: <person's name>]
3. <subject line> [From: <person's name>]

Do not show skipped sections at all, even placeholders - just skip them entirely.`,
      modelId: defaultModelId,
    },
    {
      id: uuidv7(),
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
      id: uuidv7(),
      title: 'Important Emails',
      prompt: `Review my inbox and summarize the 5 most important emails that need my attention today. Include sender, subject, and why each is important.`,
      modelId: defaultModelId,
    },
  ]

  for (const promptData of seedData) {
    await db.insert(promptsTable).values(promptData)
  }
}
