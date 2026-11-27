/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { downloadFile } from './download'

/**
 * Serializes the payload to JSON and saves it.
 *
 * Delegates to {@link downloadFile} rather than clicking its own blob-URL
 * anchor. It used to do the latter, with a comment claiming the anchor works in
 * Tauri's webview — it does not. There is no download manager behind it there,
 * so Settings → Export did nothing at all in the desktop app, the same way the
 * artifact download button did until it grew a desktop path of its own. One
 * implementation means one platform gap to fix, once.
 *
 * Resolves to the name the file was written under, which may carry a numeric
 * suffix if the folder already had one.
 */
export const downloadJson = (filename: string, payload: unknown): Promise<string> =>
  downloadFile({ name: filename, contents: JSON.stringify(payload), mimeType: 'application/json' })

/** `YYYY-MM-DD` in the user's local timezone, so the name matches the calendar day they hit "Export" on. */
const localDateStamp = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Returns the canonical export filename for a given timestamp: `thunderbolt-export-YYYY-MM-DD.json`. */
export const exportFilenameFor = (date: Date): string => `thunderbolt-export-${localDateStamp(date)}.json`

/** Longest title kept in a chat's filename, in characters, so the name stays well under filesystem limits. */
const maxTitleLength = 40

/**
 * The chat title as filename text: letters with their combining marks (so Devanagari and similar scripts survive),
 * digits, spaces, dots, dashes and underscores, shortened. What remains is safe on every filesystem we save to.
 */
const fileNameTitle = (title: string | null): string => {
  const cleaned = (title ?? '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Zs}._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...cleaned].slice(0, maxTitleLength).join('').trim() || 'chat'
}

/** Returns the filename for one exported chat: `thunderbolt-chat-<title>-YYYY-MM-DD.json`. */
export const chatExportFilenameFor = (title: string | null, date: Date): string =>
  `thunderbolt-chat-${fileNameTitle(title)}-${localDateStamp(date)}.json`
