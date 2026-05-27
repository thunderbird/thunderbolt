/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { findSkillTokens } from './parse-skill-tokens'

/**
 * Render the chat input's text with `/slug` tokens highlighted:
 * - Tokens that resolve to an enabled skill render in blue.
 * - Tokens that don't resolve render in orange so the user spots the typo
 *   before they send.
 *
 * The overlay this renders into is `pointer-events-none` (so the textarea
 * underneath stays interactive), which is why we lean on color alone for
 * the unresolved-token cue — a hover tooltip would be unreachable.
 *
 * The trailing zero-width space preserves a final newline; without it the
 * overlay collapses and falls one row behind the textarea.
 *
 * @param value The current textarea value.
 * @param isValidSkill Predicate against the bare slug (no leading `/`).
 */
export const renderHighlightedSkillTokens = (value: string, isValidSkill: (slug: string) => boolean): ReactNode[] => {
  const tokens = findSkillTokens(value)
  if (tokens.length === 0) {
    return [value, '​']
  }

  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (const { slug, start, end } of tokens) {
    if (start > cursor) {
      parts.push(value.slice(cursor, start))
    }
    const token = value.slice(start, end)
    const className = isValidSkill(slug) ? 'text-sky-500 dark:text-sky-400' : 'text-orange-500 dark:text-orange-400'
    parts.push(
      <span key={key++} className={className}>
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
