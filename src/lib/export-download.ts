/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Compresses the payload to gzip and triggers a browser download.
 *
 * Why gzip: chat-message JSON compresses to ~10-15% of the original. A heavy
 * user's export drops from tens of MB to a few — the file is faster to write,
 * cheaper to keep around, and stays well under the importer's 200 MB cap.
 *
 * The JSON is serialized without indentation; a backup file is consumed by the
 * matching importer, not eyeballed in a text editor, and `gunzip -c | jq` (or
 * any JSON tool) re-pretty-prints it for inspection if needed.
 *
 * Works on both web and Tauri's WebView via the universal `<a download>` blob-
 * URL pattern. The blob URL is revoked on the next macrotask, not synchronously
 * after the click — WebKit (Safari / iOS / Tauri's iOS WebView) will sometimes
 * cancel the download if the URL is revoked before the browser starts streaming
 * the blob to disk.
 */
export const downloadJson = async (filename: string, payload: unknown): Promise<void> => {
  const json = JSON.stringify(payload)
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))
  const blob = await new Response(stream).blob()
  const gzipped = new Blob([blob], { type: 'application/gzip' })
  const url = URL.createObjectURL(gzipped)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Returns the canonical export filename for a given timestamp.
 * Format: `thunderbolt-export-YYYY-MM-DD.json.gz` in the user's local timezone
 * so the filename matches the calendar day they hit "Export" on. The `.json.gz`
 * suffix mirrors what `gunzip` produces — `gunzip thunderbolt-export-…json.gz`
 * yields a `.json` file inspectable with any tool.
 */
export const exportFilenameFor = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `thunderbolt-export-${year}-${month}-${day}.json.gz`
}
