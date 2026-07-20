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
 * Render the chat input's text with `/slug` tokens highlighted. The `/` is
 * purely a menu trigger, so its glyph is never painted: every token — and
 * the bare trailing `/` that just opened the picker — renders it as a
 * transparent character (width preserved, so caret alignment holds).
 * - In-progress (still typing at end of input) → no special color; the token
 *   inherits the surrounding text color so partial input doesn't flicker
 *   between states as the user types.
 * - Committed (followed by whitespace) → an inline pill badge (`.skill-token`,
 *   a paint-only background + box-shadow ring that cannot disturb the
 *   textarea's line metrics) showing only the name, tinted by status:
 *   - enabled → a quiet beige-gray chip, the resting "this will resolve" state.
 *   - disabled → amber, the "needs attention" signal.
 *   - unknown → red, "no skill by this name."
 *
 * Committed disabled / unknown tokens are wrapped in {@link SkillTokenPopover}
 * so hovering the token surfaces an Enable / Create-it action. Those spans
 * are individually `pointer-events-auto`; the overlay around them stays
 * `pointer-events-none` so the textarea below remains interactive.
 *
 * The trailing zero-width space preserves a final newline; without it the
 * overlay collapses and falls one row behind the textarea.
 */
export const renderHighlightedSkillTokens = (
  value: string,
  classify: SkillStatusClassifier,
  /** Display-title → slug map so `/Daily Brief` tokens highlight as chips.
   *  The rendered glyphs always mirror the textarea exactly (title or slug,
   *  whatever the text contains) — only the classification uses the slug. */
  displayNameToSlug?: ReadonlyMap<string, string>,
): ReactNode[] => {
  const tokens = findSkillTokens(value, displayNameToSlug)
  let key = 0

  // The `/` is purely a menu trigger — it should never render as a visible
  // glyph. Every token (committed chip or in-progress) hides it, and so does
  // the bare trailing `/` the user just typed to open the picker (not yet a
  // token — the grammar needs at least one following char). The character
  // stays in the flow (transparent, same width) so overlay glyphs and the
  // textarea's caret positions still mirror exactly.
  const hiddenSlash = () => (
    <span key={key++} className="text-transparent">
      /
    </span>
  )

  /** Push `text`, hiding a trailing menu-trigger `/` (start-of-input or
   *  after whitespace, at the very end of the value). */
  const pushPlainText = (parts: ReactNode[], text: string, endsValue: boolean) => {
    const isTriggerSlash = endsValue && text.endsWith('/') && (text.length === 1 || /\s/.test(text[text.length - 2]))
    if (!isTriggerSlash) {
      parts.push(text)
      return
    }
    parts.push(text.slice(0, -1), hiddenSlash())
  }

  if (tokens.length === 0) {
    const parts: ReactNode[] = []
    pushPlainText(parts, value, true)
    parts.push('​')
    return parts
  }

  const parts: ReactNode[] = []
  let cursor = 0
  for (const { slug, start, end, committed } of tokens) {
    if (start > cursor) {
      pushPlainText(parts, value.slice(cursor, start), false)
    }
    const token = value.slice(start, end)
    const { status, skillId } = classify(slug)
    const colorClass = colorClassFor(committed, status)
    const tokenSpan = (
      <span key={key++} className={colorClass}>
        {hiddenSlash()}
        {value.slice(start + 1, end)}
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
    pushPlainText(parts, value.slice(cursor), true)
  }
  parts.push('​')
  return parts
}

const colorClassFor = (committed: boolean, status: SkillTokenStatus): string => {
  if (!committed) {
    // Still typing — inherit the surrounding text color so the in-progress
    // token doesn't flicker between states as each character arrives. Once
    // the user adds a trailing space we re-classify against the three
    // committed states below.
    return ''
  }
  // `.skill-token` draws the pill from currentColor, so each status only
  // needs a text color. Enabled uses the theme's warm beige-gray
  // (muted-foreground) — the resting "this will resolve" state should read
  // as a quiet chip in the theme's neutral palette, not an accent. Disabled
  // is amber (attention), unknown is red.
  if (status === 'enabled') {
    return 'skill-token text-muted-foreground'
  }
  if (status === 'disabled') {
    return 'skill-token text-amber-700 dark:text-amber-400'
  }
  return 'skill-token text-red-600 dark:text-red-400'
}
