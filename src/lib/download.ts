/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Save a generated file to the user's Downloads folder.
 *
 * The browser trick — an `<a download>` pointed at a blob URL, clicked
 * programmatically — is the only mechanism available on the web, and it does
 * **not** work in the Tauri webview: there is no download manager behind it, so
 * the click resolves to nothing at all. No error, no file, no console output,
 * which is exactly how the artifact download button came to look broken on
 * desktop while working in every browser.
 *
 * So the two platforms need two mechanisms, and the difference is not a
 * refinement: on desktop we write the bytes ourselves through `plugin-fs`,
 * which needs a matching grant in `src-tauri/capabilities/default.json`
 * (`$DOWNLOAD/*` for both write and exists).
 */

import { isTauri } from './platform'

export type DownloadRequest = {
  /** Filename including extension. Collisions get a numeric suffix. */
  name: string
  contents: string
  mimeType: string
}

/** `report.html` → `report (1).html`, matching what a browser does. Exported for its own test. */
export const withSuffix = (name: string, attempt: number): string => {
  if (attempt === 0) {
    return name
  }
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name} (${attempt})` : `${name.slice(0, dot)} (${attempt})${name.slice(dot)}`
}

/**
 * Write to Downloads, without overwriting anything already there.
 *
 * Bounded rather than looping until it finds a gap: a directory that somehow
 * has twenty of these does not need a twenty-first, and an unbounded loop over
 * a filesystem call is a hang waiting for an unusual disk.
 */
const saveViaTauri = async (request: DownloadRequest): Promise<string> => {
  const { writeTextFile, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs')

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = withSuffix(request.name, attempt)
    if (await exists(name, { baseDir: BaseDirectory.Download })) {
      continue
    }
    await writeTextFile(name, request.contents, { baseDir: BaseDirectory.Download })
    return name
  }
  throw new Error(`Could not find an unused name for ${request.name} in Downloads`)
}

const saveViaBrowser = (request: DownloadRequest): string => {
  const url = URL.createObjectURL(new Blob([request.contents], { type: request.mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = request.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Deferred so the browser has time to start reading the blob — revoking
  // synchronously after click() can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return request.name
}

/**
 * Save a file, resolving to the name it was actually written under.
 *
 * Throws on failure rather than reporting it, so the caller decides what the
 * user sees. Silence is the one thing this must not do.
 */
export const downloadFile = async (request: DownloadRequest): Promise<string> =>
  isTauri() ? saveViaTauri(request) : saveViaBrowser(request)
