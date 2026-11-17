/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Characters a filesystem we save to rejects in a name, control characters, and
 * invisible format characters: a right-to-left override in the name would
 * reverse the prompt's own sentence around it. Also a lone surrogate, such as
 * half an emoji left where a long name is cut, which no filesystem name holds.
 */
const unsafeCharacters = /[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/gu

/**
 * Names Windows refuses whatever follows the first dot: `CON.pdf` and
 * `aux.notes.pdf` cannot be created.
 */
const reservedNames = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

/** Longest stem in UTF-8 bytes. ext4 and APFS cap a whole name at 255 bytes, and CJK takes three each. */
const maxStemBytes = 200

/**
 * How much of a raw name to read, counted from its end so the extension survives. The trimming backtracks on a long
 * run of dots, so an unbounded name could freeze the app.
 */
const maxRawLength = 1024

/** Characters that reorder the text around them: a right-to-left override before `xcod.xlsx` makes the name read as a `.docx`. */
const bidiControls = /\p{Bidi_Control}/gu

/** A file name as the user should see it: without bidirectional controls, so the real extension shows. */
export const withoutBidiControls = (name: string): string => name.replace(bidiControls, '')

/**
 * A file name as model-facing data: a JSON string, so a quote, bracket or line break in the name cannot end its label
 * and read as instructions. Invisible format characters, such as a right-to-left override, are escaped too, so they
 * cannot reorder the text around the name. The model can pass the name back in a tool call's JSON unchanged.
 */
export const promptFileName = (name: string): string =>
  JSON.stringify(name).replace(/\p{Cf}/gu, (character) =>
    Array.from({ length: character.length }, (_, index) => {
      const unit = character.charCodeAt(index).toString(16).padStart(4, '0')
      return `\\u${unit}`
    }).join(''),
  )

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
 */
export const safeFileName = (raw: string): SafeFileName => {
  // Trailing dots and spaces go first, as Windows drops them: `report.pdf.` is `report.pdf`.
  const cleaned = raw
    .slice(-maxRawLength)
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

/** {@link safeFileName} joined back into one name, such as `Meeting 10 30.docx` for `Meeting 10:30.docx`. */
export const safeFileNameString = (raw: string): string => {
  const { stem, extension } = safeFileName(raw)
  return extension ? `${stem}.${extension}` : stem
}
