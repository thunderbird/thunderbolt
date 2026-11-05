/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JSONValue } from 'ai'
import type { ReasoningEffort } from '@shared/reasoning-effort'

type Options = Record<string, JSONValue>

/** Override reasoning controls without discarding unrelated profile options such as excluded reasoning output. */
export const reasoningProviderOptions = (
  profile: Options,
  provider: string,
  effort: ReasoningEffort,
  budgetThinking: boolean,
): Options => {
  const options = Object.fromEntries(
    Object.entries(profile).filter(
      ([key]) => !['reasoningEffort', 'reasoning_effort', 'reasoning', 'thinking', 'effort'].includes(key),
    ),
  )
  if (provider === 'openrouter') {
    const reasoning = profile.reasoning
    const preserved =
      reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)
        ? Object.fromEntries(
            Object.entries(reasoning).filter(([key]) => !['effort', 'max_tokens', 'enabled'].includes(key)),
          )
        : {}
    return { ...options, reasoning: { ...preserved, effort } }
  }
  if (provider !== 'anthropic') {
    return { ...options, reasoningEffort: effort }
  }
  if (effort === 'none') {
    return { ...options, thinking: { type: 'disabled' } }
  }
  if (budgetThinking) {
    return { ...options, thinking: { type: 'enabled', budgetTokens: 4096 } }
  }
  return { ...options, thinking: { type: 'adaptive' }, effort }
}
