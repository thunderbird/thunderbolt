/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Skill } from '@/types'
import { type SkillStatusClassifier } from './highlight-skill-tokens'
import { findSkillTokens } from './parse-skill-tokens'
import { type SkillRefProblem } from './skill-ref-alerts'

/**
 * Append a `/slug` token to `value` for the chat composer, normalizing
 * surrounding whitespace so the resulting input is one of:
 *
 * - `"/slug "` — when the input was empty or already held *only* the token.
 * - `"<existing> /slug "` — when the input has other content. Any trailing
 *   whitespace on the existing content is collapsed to a single space.
 *
 * Pulled out of `chat-prompt-input.tsx` so the rule (and its edge cases) is
 * unit-testable without spinning up the chat-store / draft-input stack.
 */
export const appendSlashToken = (value: string, slug: string): string => {
  const token = `/${slug}`
  const trimmed = value.trim()
  const onlyHoldsToken = trimmed === token
  if (value.length === 0 || onlyHoldsToken) {
    return `${token} `
  }
  return `${value.replace(/\s+$/, '')} ${token} `
}

/**
 * Walk the committed slash tokens in `input` and emit a list of references
 * the chat composer should surface to the user — disabled skills (we know
 * the id so we can offer "Enable") and unknown names (no skill exists).
 *
 * In-progress tokens (still being typed at the very end of the input) and
 * tokens that resolve to enabled skills are intentionally skipped:
 * - In-progress: nagging mid-keystroke is bad UX.
 * - Enabled: nothing to surface.
 *
 * Duplicates are deduped by slug — one alert row per problematic name.
 */
export const computeSkillRefProblems = (
  input: string,
  classify: SkillStatusClassifier,
  skillBySlug: ReadonlyMap<string, Skill>,
): SkillRefProblem[] => {
  const tokens = findSkillTokens(input)
  const seen = new Set<string>()
  const problems: SkillRefProblem[] = []
  for (const { slug, committed } of tokens) {
    if (!committed || seen.has(slug)) {
      continue
    }
    seen.add(slug)
    const status = classify(slug)
    if (status === 'enabled') {
      continue
    }
    const skill = skillBySlug.get(slug)
    if (status === 'disabled' && skill) {
      problems.push({ kind: 'disabled', slug, skillId: skill.id })
    } else {
      problems.push({ kind: 'unknown', slug })
    }
  }
  return problems
}
