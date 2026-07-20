/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Append a `/name` token to `value` for the chat composer, normalizing
 * surrounding whitespace. `name` may be a display title with spaces
 * (`Daily Brief`) — the send path maps display tokens back to slugs.
 *
 * If the input already *ends* with the token we're about to add, the call
 * is a no-op (returns the existing value) — clicking the same chip twice
 * shouldn't double-insert, and clicking a different chip back-to-back
 * shouldn't keep appending the new one if it's already at the end either.
 *
 * Otherwise the result is one of:
 *
 * - `"/name "` — when the input was empty.
 * - `"<existing> /name "` — otherwise. Any trailing whitespace on the
 *   existing content is collapsed to a single space.
 *
 * Pulled out of `chat-prompt-input.tsx` so the rule (and its edge cases) is
 * unit-testable without spinning up the chat-store / draft-input stack.
 */
export const appendSlashToken = (value: string, name: string): string => {
  const token = `/${name}`
  if (value.length === 0) {
    return `${token} `
  }
  // If the input (ignoring trailing whitespace) already ends with this token
  // at a token boundary, skip the append. An `endsWith` check (rather than
  // splitting on the last space) keeps this correct for multi-word display
  // titles.
  const trimmedRight = value.replace(/\s+$/, '')
  const boundaryChar = trimmedRight[trimmedRight.length - token.length - 1]
  const endsWithToken =
    trimmedRight.endsWith(token) && (trimmedRight.length === token.length || /\s/.test(boundaryChar))
  if (endsWithToken) {
    // Preserve the existing trailing space behaviour: if there was no space
    // after the token, add one so the caret lands clear of it.
    return value.endsWith(' ') ? value : `${trimmedRight} `
  }
  return `${trimmedRight} ${token} `
}
