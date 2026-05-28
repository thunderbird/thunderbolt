/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Append a `/slug` token to `value` for the chat composer, normalizing
 * surrounding whitespace.
 *
 * If the *last* slash token already in the input matches the slug we're
 * about to add, the call is a no-op (returns the existing value) — clicking
 * the same chip twice shouldn't double-insert, and clicking a different
 * chip back-to-back shouldn't keep appending the new one if it's already at
 * the end either.
 *
 * Otherwise the result is one of:
 *
 * - `"/slug "` — when the input was empty.
 * - `"<existing> /slug "` — otherwise. Any trailing whitespace on the
 *   existing content is collapsed to a single space.
 *
 * Pulled out of `chat-prompt-input.tsx` so the rule (and its edge cases) is
 * unit-testable without spinning up the chat-store / draft-input stack.
 */
export const appendSlashToken = (value: string, slug: string): string => {
  const token = `/${slug}`
  if (value.length === 0) {
    return `${token} `
  }
  // Last token in the input — defined as the trailing run after the final
  // whitespace, ignoring any trailing whitespace itself. If that already
  // matches the token we're adding, skip the append.
  const trimmedRight = value.replace(/\s+$/, '')
  const lastSpace = Math.max(
    trimmedRight.lastIndexOf(' '),
    trimmedRight.lastIndexOf('\n'),
    trimmedRight.lastIndexOf('\t'),
  )
  const lastToken = trimmedRight.slice(lastSpace + 1)
  if (lastToken === token) {
    // Preserve the existing trailing space behaviour: if there was no space
    // after the token, add one so the caret lands clear of the slug.
    return value.endsWith(' ') ? value : `${trimmedRight} `
  }
  return `${trimmedRight} ${token} `
}
