/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@/lib/utils'
import type { Prompt } from '@/types'
import { defaultModelGptOss120b } from './models'

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
  userId: null,
  modelId: defaultModelGptOss120b.id,
  prompt: `Create a daily brief with the following sections. Do not ask me for any missing information - just skip sections for which you are missing information or tools.

1. If you know my location, show me the 7-day forecast. If not, skip this section.

2. Today's top news stories. Use the fetch_content tool to get the content of apnews.com. Provide the top 10 headlines in an ordered list. Do not include link previews.

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

export const defaultAutomationImportantEmails: Prompt = {
  id: '0198ecc5-cc2b-735b-b478-a61c73ab50d6',
  title: 'Important Emails',
  deletedAt: null,
  defaultHash: null,
  userId: null,
  modelId: defaultModelGptOss120b.id,
  prompt: `Review my inbox and summarize the 5 most important emails that need my attention today. Include sender, subject, and why each is important.`,
}

/**
 * Array of all default automations for iteration
 */
export const defaultAutomations: ReadonlyArray<Prompt> = [
  defaultAutomationDailyBrief,
  defaultAutomationImportantEmails,
] as const
