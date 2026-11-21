/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectMinimalMode, useConfigStore } from '@/api/config-store'
import { skillInstruction } from '@/defaults/skills'
import type { Skill, ThunderboltUIMessage } from '@/types'
import { parseSkillTokens } from './parse-skill-tokens'

/**
 * Resolve slash tokens in `text` against `instructionBySlug` and return one
 * instruction per unique resolved skill in first-seen order.
 *
 * Single source of truth shared by:
 * - `chat-prompt-input.tsx` — sums tokens into `additionalInputTokens` so
 *   the overflow modal accounts for resolved instructions (through
 *   `resolveSkillTokenSkills`).
 * - `ai/fetch.ts` — prepends the same instructions as `role: 'system'`
 *   messages on every send / regenerate (through `loadSkillTokenInstructions`).
 *
 * Keeping both surfaces on the same helper means a future change to
 * resolution semantics (e.g. case-insensitive matching) doesn't drift
 * between the budget estimate and the actual model call.
 *
 * Returns nothing in minimal mode, where `/` is ordinary text. Every send path
 * (the composer estimate, the built-in pipeline in `ai/fetch.ts` and
 * `built-in-adapter.ts`, and the ACP/hosted agents via `chat-instance.ts`)
 * resolves through this one function, so gating here covers them all and the
 * message text reaches the agent verbatim.
 */
export const resolveSkillTokenInstructions = (
  text: string,
  instructionBySlug: ReadonlyMap<string, string>,
): string[] => {
  if (!text || instructionBySlug.size === 0 || selectMinimalMode(useConfigStore.getState().config)) {
    return []
  }
  const { systemMessages } = parseSkillTokens(text, (slug) => {
    const instruction = instructionBySlug.get(slug)
    return instruction ? { instruction } : null
  })
  return systemMessages
}

/**
 * The skills the slash tokens in `text` name, one per unique slug in first-seen order, resolved exactly as
 * {@link resolveSkillTokenInstructions} resolves them, for a caller that loads or measures the instructions itself.
 */
export const resolveSkillTokenSkills = <T extends Pick<Skill, 'name' | 'instruction'>>(
  text: string,
  skills: readonly T[],
): T[] => {
  const skillBySlug = new Map(skills.map((skill) => [skill.name, skill]))
  // Each slug stands in for its instruction, so the resolver returns the slugs it resolved. Empty stays unresolved.
  const slugBySlug = new Map([...skillBySlug].map(([slug, { instruction }]) => [slug, instruction && slug]))
  return resolveSkillTokenInstructions(text, slugBySlug).flatMap((slug) => skillBySlug.get(slug) ?? [])
}

/**
 * The instructions the slash tokens in `text` name, for a built-in send. Only a named skill's instructions load, so an
 * Office manual stays unloaded unless its own `/office-…` token is in the message.
 */
export const loadSkillTokenInstructions = (
  text: string,
  skills: readonly Pick<Skill, 'id' | 'name' | 'instruction'>[],
): Promise<string[]> => Promise.all(resolveSkillTokenSkills(text, skills).map((skill) => skillInstruction(skill)))

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
