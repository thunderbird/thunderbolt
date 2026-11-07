/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Build the local SVG filename, ignoring presentation selectors as the asset copy step does. */
export const emojiAssetFilename = (emoji: string): string => {
  const normalized = emoji.replaceAll('\ufe0f', '')
  return `${Array.from(normalized, (character) => character.codePointAt(0)!.toString(16)).join('-')}.svg`
}
