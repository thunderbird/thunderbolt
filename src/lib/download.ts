/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Save a generated file where the user can find it, as text or bytes.
 *
 * The browser trick — an `<a download>` pointed at a blob URL, clicked
 * programmatically — is the only mechanism available on the web, and it does
 * **not** work in the Tauri webview: there is no download manager behind it, so
 * the click resolves to nothing at all. No error, no file, no console output,
 * which is exactly how the artifact download button came to look broken on
 * desktop while working in every browser. `pdf-sidebar-viewer.tsx` still clicks
 * its own anchor at a blob URL, so it still carries that bug until it moves here.
 *
 * So each platform saves its own way:
 *
 * - **Web**: the anchor trick, into the browser's Downloads.
 * - **Desktop**: `save_to_downloads` in `platform_utils.rs` writes into
 *   Downloads. It creates the file and, while it is still empty, marks it as
 *   downloaded from the internet the way a browser marks its downloads, so Word
 *   opens it in Protected View. Then it writes the bytes. If either step fails,
 *   it deletes the file. `plugin-fs` writes a file in one call, and a call that
 *   fails half way leaves an unmarked file behind, so the webview has no grant
 *   to write into Downloads at all.
 * - **iOS**: `plugin-fs` writes into `BaseDirectory.Document`. Tauri resolves
 *   `Download` to a `~/Downloads` the app sandbox does not have, and the Files
 *   app shows only the app's `Documents` (`UIFileSharingEnabled` in
 *   `Info.plist`). The `$DOCUMENT/*` grants live in
 *   `src-tauri/capabilities/ios-documents.json`, scoped to iOS.
 * - **Android**: `plugin-fs`'s `Download` is the app-private
 *   `getExternalFilesDir`, which the Files app does not show, so `saveToDownloads` in
 *   the Kotlin `PlatformUtilsPlugin` answers the same command as desktop and
 *   inserts into the public Downloads folder through MediaStore. It needs
 *   Android 10 (API 29) and refuses with a message below that.
 *
 * Capabilities, the Rust command and the Kotlin plugin are compiled into the
 * binary, so an app build older than them refuses the save no matter what this
 * file does.
 *
 * Every save goes through here (`downloadJson` in `export-download.ts` and Mini
 * App downloads included) except the PDF viewer noted above. Anything that
 * reimplements the anchor trick for itself is silently web-only, which is the
 * bug above wearing a different filename.
 */

import { invoke } from '@tauri-apps/api/core'
import { BaseDirectory } from '@tauri-apps/api/path'
import { uint8ArrayToBase64 } from '@/crypto/primitives'
import { getPlatform, isTauri } from './platform'

export type DownloadRequest = {
  /** Filename including extension. Collisions get a numeric suffix. */
  name: string
  /** Text is written as UTF-8, bytes as they are. */
  contents: string | Uint8Array<ArrayBuffer>
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
  writeFile: (path: string, data: Uint8Array, options: { baseDir: number; createNew?: boolean }) => Promise<void>
}

/**
 * `save_to_downloads`, answered by `platform_utils.rs` on desktop and `PlatformUtilsPlugin.kt` on Android.
 * `data` is the file's bytes in base64, as IPC args are JSON.
 */
export type SaveToDownloadsArgs = { name: string; mimeType: string; data: string }

/** What a save inside Tauri needs. None of it means anything outside the webview, so tests supply it. */
export type DownloadNative = {
  platform: ReturnType<typeof getPlatform>
  fs: DownloadFs
  /** `invoke` from `@tauri-apps/api/core`, narrowed to what `save_to_downloads` resolves with. */
  invoke: (command: string, args: SaveToDownloadsArgs) => Promise<{ name: string }>
}

const loadNative = async (): Promise<DownloadNative> => {
  const { writeTextFile, writeFile } = await import('@tauri-apps/plugin-fs')
  return { platform: getPlatform(), fs: { writeTextFile, writeFile }, invoke }
}

/**
 * Write into the app's `Documents` on iOS, without overwriting anything already there.
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
 * A failure that isn't a collision, such as a missing grant or a full disk,
 * looks identical here, so it costs the remaining attempts and then rethrows *its own* error
 * rather than a synthesized "no unused name". The caller shows that text, and
 * it is the only thing that distinguishes a missing permission from a crowded
 * folder.
 */
const saveToDocuments = async (request: DownloadRequest, fs: DownloadFs): Promise<string> => {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = withSuffix(request.name, attempt)
    const options = { baseDir: BaseDirectory.Document, createNew: true }
    try {
      await (typeof request.contents === 'string'
        ? fs.writeTextFile(name, request.contents, options)
        : fs.writeFile(name, request.contents, options))
      return name
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not save ${request.name} to Documents: ${String(lastError)}`)
}

/**
 * Hand the file to `save_to_downloads`. The Rust and the Kotlin side both
 * suffix a taken name themselves, so the name it reports is the one to show. Text goes in as UTF-8
 * bytes, so one command covers both kinds: a `Blob` encodes it exactly as
 * `saveViaBrowser`'s does.
 */
const saveToDownloads = async (request: DownloadRequest, invoke: DownloadNative['invoke']): Promise<string> => {
  const bytes = new Uint8Array(await new Blob([request.contents]).arrayBuffer())
  try {
    const saved = await invoke('plugin:platform-utils|save_to_downloads', {
      name: request.name,
      mimeType: request.mimeType,
      data: uint8ArrayToBase64(bytes),
    })
    return saved.name
  } catch (error) {
    // Kotlin rejects with a plain `{ message }`, which callers' `String(error)` shows as "[object Object]".
    throw new Error(error instanceof Object && 'message' in error ? String(error.message) : String(error), {
      cause: error,
    })
  }
}

const saveNatively = (request: DownloadRequest, { platform, fs, invoke }: DownloadNative): Promise<string> =>
  platform === 'ios' ? saveToDocuments(request, fs) : saveToDownloads(request, invoke)

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
 * `native` lets tests run the Tauri branches, which are the ones that had the
 * bugs: `plugin-fs`, the platform and the native command mean nothing outside
 * the webview.
 */
export const downloadFile = async (request: DownloadRequest, native?: DownloadNative): Promise<string> => {
  if (native) {
    return saveNatively(request, native)
  }
  return isTauri() ? saveNatively(request, await loadNative()) : saveViaBrowser(request)
}
