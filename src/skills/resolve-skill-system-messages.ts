/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { parseSkillTokens } from './parse-skill-tokens'

/**
 * Resolve slash tokens in `text` against `instructionBySlug` and return one
 * instruction per unique resolved skill in first-seen order.
 *
 * Single source of truth shared by:
 * - `chat-prompt-input.tsx` — sums tokens into `additionalInputTokens` so
 *   the overflow modal accounts for resolved instructions.
 * - `ai/fetch.ts` — prepends the same instructions as `role: 'system'`
 *   messages on every send / regenerate.
 *
 * Keeping both surfaces on the same helper means a future change to
 * resolution semantics (e.g. case-insensitive matching) doesn't drift
 * between the budget estimate and the actual model call.
 */
export const resolveSkillTokenInstructions = (
  text: string,
  instructionBySlug: ReadonlyMap<string, string>,
): string[] => {
  if (!text || instructionBySlug.size === 0) {
    return []
  }
  const { systemMessages } = parseSkillTokens(text, (slug) => {
    const instruction = instructionBySlug.get(slug)
    return instruction ? { instruction } : null
  })
  return systemMessages
}

/**
 * Walk `messages` from the end and return the concatenated text of the most
 * recent `user` message (its `text` parts joined by `\n`). Returns the empty
 * string if there is no user message.
 */
export const extractLastUserText = (messages: readonly ThunderboltUIMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') {
      continue
    }
    return message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}
