/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WebToolIntent } from './web-tool-budget'
import { skillTokenRegex } from '@/skills/parse-skill-tokens'

const skillWebIntents: ReadonlyMap<string, WebToolIntent> = new Map([
  ['search', 'search'],
  ['research', 'research'],
])

/** Map a canonical skill name to this turn's web intent. */
export const resolveSkillWebToolIntent = (name: string): WebToolIntent => skillWebIntents.get(name) ?? 'auto'

/** Resolve explicit slash commands through the same map used for loaded skills. */
export const resolveWebToolIntent = (lastUserText: string): WebToolIntent => {
  const intents = [...lastUserText.matchAll(skillTokenRegex)].map((match) => resolveSkillWebToolIntent(match[1]))
  if (intents.includes('research')) {
    return 'research'
  }
  return intents.includes('search') ? 'search' : 'auto'
}

export const webBudgetExhaustedMessage =
  'Per-turn web tool budget reached. Answer now from the results already gathered. If coverage is insufficient, tell the user they can ask you to search more or use /research.'
