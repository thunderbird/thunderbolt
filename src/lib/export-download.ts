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
 * artifact download button did before THU-857. One implementation means one
 * platform gap to fix, once.
 *
 * Resolves to the name the file was written under, which may carry a numeric
 * suffix if the folder already had one.
 */
export const downloadJson = (filename: string, payload: unknown): Promise<string> =>
  downloadFile({ name: filename, contents: JSON.stringify(payload), mimeType: 'application/json' })

/**
 * Returns the canonical export filename for a given timestamp.
 * Format: `thunderbolt-export-YYYY-MM-DD.json` in the user's local timezone so
 * the filename matches the calendar day they hit "Export" on.
 */
export const exportFilenameFor = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `thunderbolt-export-${year}-${month}-${day}.json`
}
