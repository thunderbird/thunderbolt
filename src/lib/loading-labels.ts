/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Maps a chat mode name to the status label shown in the "submitted" window —
 * after the user sends a message but before the model emits its first token.
 *
 * Only modes whose pre-token action is known and truthful return a label:
 * - `search`   → "Searching the web…"
 * - `research` → "Researching…"
 *
 * Plain chat (and any custom mode) has no specific, honest action to describe
 * before the first token, so it returns `undefined` and the caller keeps the
 * plain spinner. Generic filler ("Thinking…") is intentionally avoided — vendor
 * and community UX guidance rates it worse than a bare spinner.
 *
 * @param modeName - The selected mode's `name` (e.g. `selectedMode.name`).
 * @returns A specific, static status label, or `undefined` to keep the spinner.
 */
export const getLoadingLabel = (modeName: string): string | undefined => {
  if (modeName === 'search') {
    return 'Searching the web…'
  }
  if (modeName === 'research') {
    return 'Researching…'
  }
  return undefined
}
