/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Serializes the payload to JSON and triggers a browser download.
 *
 * Works on both web and Tauri's WebView via the universal `<a download>` blob-
 * URL pattern. The blob URL is revoked on the next macrotask, not synchronously
 * after the click — WebKit (Safari / iOS / Tauri's iOS WebView) will sometimes
 * cancel the download if the URL is revoked before the browser starts streaming
 * the blob to disk.
 */
export const downloadJson = (filename: string, payload: unknown): void => {
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
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
 * Format: `thunderbolt-export-YYYY-MM-DD.json` in the user's local timezone so
 * the filename matches the calendar day they hit "Export" on.
 */
export const exportFilenameFor = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `thunderbolt-export-${year}-${month}-${day}.json`
}
