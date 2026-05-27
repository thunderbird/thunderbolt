/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { findSkillTokens } from './parse-skill-tokens'
import { SkillTokenPopover } from './skill-token-popover'

/** Resolution state of a slash token against the user's skill library. */
export type SkillTokenStatus = 'enabled' | 'disabled' | 'unknown'

/**
 * Lookup function passed by the composer. Resolves a bare slug to:
 * - `enabled`: an enabled skill exists; we also return its id for deep-link.
 * - `disabled`: a soft-disabled skill exists; id is for the "Enable" link.
 * - `unknown`: no skill by that name.
 *
 * Returning a structured object (rather than separate predicates) keeps the
 * renderer's switch statement honest — the popover for `disabled` needs the
 * skill id, the popover for `unknown` doesn't.
 */
export type SkillStatusClassifier = (slug: string) => { status: SkillTokenStatus; skillId?: string }

/**
 * Render the chat input's text with `/slug` tokens highlighted:
 * - Committed (followed by whitespace) + enabled → blue, the green light.
 * - In-progress (still typing at end of input) OR committed + disabled →
 *   orange, the "still pending" / "needs attention" signal.
 * - Committed + unknown → red, "no skill by this name."
 *
 * Committed disabled / unknown tokens are wrapped in {@link SkillTokenPopover}
 * so hovering the token surfaces an Enable / Create-it action. Those spans
 * are individually `pointer-events-auto`; the overlay around them stays
 * `pointer-events-none` so the textarea below remains interactive.
 *
 * The trailing zero-width space preserves a final newline; without it the
 * overlay collapses and falls one row behind the textarea.
 */
export const renderHighlightedSkillTokens = (value: string, classify: SkillStatusClassifier): ReactNode[] => {
  const tokens = findSkillTokens(value)
  if (tokens.length === 0) {
    return [value, '​']
  }

  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const { slug, start, end, committed } of tokens) {
    if (start > cursor) {
      parts.push(value.slice(cursor, start))
    }
    const token = value.slice(start, end)
    const { status, skillId } = classify(slug)
    const colorClass = colorClassFor(committed, status)
    const tokenSpan = (
      <span key={key++} className={colorClass}>
        {token}
      </span>
    )

    // Only committed problematic tokens get the interactive popover. In-progress
    // tokens (still typing) and enabled tokens stay inert so the textarea below
    // remains clickable for cursor positioning.
    if (!committed || status === 'enabled') {
      parts.push(tokenSpan)
    } else if (status === 'disabled' && skillId) {
      parts.push(
        <SkillTokenPopover
          key={key++}
          trigger={tokenSpan}
          message={`Skill ${token} is disabled.`}
          actionLabel="Enable"
          state={{ editSkill: skillId }}
        />,
      )
    } else {
      parts.push(
        <SkillTokenPopover
          key={key++}
          trigger={tokenSpan}
          message={`No skill named ${token}.`}
          actionLabel="Create it"
          state={{ createSkill: slug }}
        />,
      )
    }
    cursor = end
  }
  if (cursor < value.length) {
    parts.push(value.slice(cursor))
  }
  parts.push('​')
  return parts
}

const colorClassFor = (committed: boolean, status: SkillTokenStatus): string => {
  if (!committed) {
    // Still typing — orange regardless of resolution. Once the user adds a
    // trailing space we re-classify against the three committed states.
    return 'text-orange-500 dark:text-orange-400'
  }
  if (status === 'enabled') {
    return 'text-sky-500 dark:text-sky-400'
  }
  if (status === 'disabled') {
    return 'text-orange-500 dark:text-orange-400'
  }
  return 'text-red-500 dark:text-red-400'
}
