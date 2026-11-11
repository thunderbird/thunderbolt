/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Characters a filesystem we save to rejects in a name, control characters, and
 * invisible format characters: a right-to-left override in the name would
 * reverse the prompt's own sentence around it.
 */
const unsafeCharacters = /[\p{Cc}\p{Cf}<>:"/\\|?*]/gu

/**
 * Names Windows refuses whatever follows the first dot: `CON.pdf` and
 * `aux.notes.pdf` cannot be created.
 */
const reservedNames = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

/** Longest stem in UTF-8 bytes. ext4 and APFS cap a whole name at 255 bytes, and CJK takes three each. */
const maxStemBytes = 200

const encoder = new TextEncoder()

/** The longest prefix of `value` within `maxStemBytes`, never splitting a character. */
const boundBytes = (value: string): string =>
  Array.from(value).reduce(
    (state, character) => {
      if (state.full) {
        return state
      }
      const size = encoder.encode(character).byteLength
      return state.bytes + size > maxStemBytes
        ? { ...state, full: true }
        : { text: state.text + character, bytes: state.bytes + size, full: false }
    },
    { text: '', bytes: 0, full: false },
  ).text

/** A file name split for saving; `extension` is lowercase, without the dot, and may be empty. */
export type SafeFileName = { stem: string; extension: string }

/**
 * A name that is safe to create in Downloads: no path, nothing a filesystem
 * rejects, not hidden, not a reserved device name, and not absurdly long.
 *
 * Bound the length of `raw` before calling: the trimming backtracks on a long
 * run of dots, so an unbounded name could freeze the app.
 */
export const safeFileName = (raw: string): SafeFileName => {
  // Trailing dots and spaces go first, as Windows drops them: `report.pdf.` is `report.pdf`.
  const cleaned = raw
    .replace(unsafeCharacters, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s.]+$/, '')
  // Split before trimming the front, so `?.pdf` is an untitled PDF; a dot that
  // starts the name begins a hidden file instead, and has no extension.
  const dot = cleaned.lastIndexOf('.')
  const extension =
    dot > 0
      ? cleaned
          .slice(dot + 1)
          .trim()
          .toLowerCase()
      : ''
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).replace(/^[\s.]+|[\s.]+$/g, '')
  const bounded = boundBytes(stem).trim()
  if (bounded === '') {
    return { stem: 'download', extension }
  }
  return { stem: reservedNames.test(bounded) ? `_${bounded}` : bounded, extension }
}
