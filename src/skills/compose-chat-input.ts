/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
