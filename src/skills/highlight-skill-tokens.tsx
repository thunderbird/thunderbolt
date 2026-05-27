/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { findSkillTokens } from './parse-skill-tokens'

/** Resolution state of a slash token against the user's skill library. */
export type SkillTokenStatus = 'enabled' | 'disabled' | 'unknown'
export type SkillStatusClassifier = (slug: string) => SkillTokenStatus

/**
 * Render the chat input's text with `/slug` tokens highlighted:
 * - Committed (followed by whitespace) + enabled → blue, the green light.
 * - In-progress (still typing at end of input) OR committed + disabled →
 *   orange, the "still pending" / "needs attention" signal.
 * - Committed + unknown → red, "no skill by this name."
 *
 * The overlay this renders into is `pointer-events-none` (so the textarea
 * underneath stays interactive), which is why we lean on color alone for
 * the resolution cue — a hover tooltip would be unreachable. Actionable
 * remediation (enable / create) lives in the `SkillRefAlerts` strip
 * rendered below the input.
 *
 * The trailing zero-width space preserves a final newline; without it the
 * overlay collapses and falls one row behind the textarea.
 *
 * @param value The current textarea value.
 * @param classify Tri-state classifier against the bare slug.
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
    const status = classify(slug)
    parts.push(
      <span key={key++} className={colorClassFor(committed, status)}>
        {token}
      </span>,
    )
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
