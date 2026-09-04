/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Save a generated file to the user's Downloads folder. The one place that does.
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
 * (`$DOWNLOAD/*` for write-text-file). Capabilities are compiled into the
 * binary, so a desktop build older than that grant denies the write no matter
 * what this file does.
 *
 * Everything that saves a file goes through here — `downloadJson` in
 * `export-download.ts` included. Anything that reimplements the anchor trick
 * for itself is silently web-only, which is the bug above wearing a different
 * filename.
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

/** The slice of `@tauri-apps/plugin-fs` this needs, so a test can supply it. */
export type DownloadFs = {
  writeTextFile: (path: string, contents: string, options: { baseDir: number; createNew?: boolean }) => Promise<void>
  downloadBaseDir: number
}

const loadTauriFs = async (): Promise<DownloadFs> => {
  const { writeTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
  return { writeTextFile, downloadBaseDir: BaseDirectory.Download }
}

/**
 * Write to Downloads, without overwriting anything already there.
 *
 * `createNew` rather than asking `exists()` first: two calls are two moments,
 * and anything that lands in between — a second download of the same artifact,
 * the user saving a file by hand — was overwritten by a check that had already
 * passed. `createNew` makes the filesystem itself refuse, so the only way to
 * clobber a file is for the kernel to say the name was free.
 *
 * Bounded rather than looping until it finds a gap: a directory that somehow
 * has twenty of these does not need a twenty-first, and an unbounded loop over
 * a filesystem call is a hang waiting for an unusual disk.
 *
 * A failure that isn't a collision — no grant, a full disk, a read-only
 * Downloads folder — looks identical here, so it costs the remaining attempts
 * and then rethrows *its own* error rather than a synthesized "no unused name".
 * The caller shows that text, and it is the only thing that distinguishes a
 * missing permission from a crowded folder.
 */
const saveViaTauri = async (request: DownloadRequest, fs: DownloadFs): Promise<string> => {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = withSuffix(request.name, attempt)
    try {
      await fs.writeTextFile(name, request.contents, { baseDir: fs.downloadBaseDir, createNew: true })
      return name
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not save ${request.name} to Downloads: ${String(lastError)}`)
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
 *
 * `fs` exists for the desktop branch's own tests: `@tauri-apps/plugin-fs` has
 * no meaning outside the webview, so without an injection point that branch —
 * the one carrying the reported bug — could only be covered by not covering it.
 */
export const downloadFile = async (request: DownloadRequest, fs?: DownloadFs): Promise<string> => {
  if (fs) {
    return saveViaTauri(request, fs)
  }
  return isTauri() ? saveViaTauri(request, await loadTauriFs()) : saveViaBrowser(request)
}
