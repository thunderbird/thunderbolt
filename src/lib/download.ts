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
 * desktop while working in every browser.
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
 * Every save goes through here (`downloadJson` in `export-download.ts`, Mini
 * App downloads and the side view's file previews included). Anything that
 * reimplements the anchor trick for itself is silently web-only, which is the
 * bug above wearing a different filename.
 */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { invoke } from '@tauri-apps/api/core'
import { BaseDirectory } from '@tauri-apps/api/path'
import { z } from 'zod'
import { uint8ArrayToBase64 } from '@/crypto/primitives'
import { getPlatform, isTauri } from './platform'
import { safeFileNameString } from './safe-file-name'

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
 * rather than a synthesized "no unused name". `saveErrorMessage` reads that
 * text, and it is the only thing that distinguishes a missing permission from a
 * crowded folder.
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

/** What `save_to_downloads` rejects with. Tauri's own failures, such as a missing command, carry no `code`. */
const nativeRejection = z.object({ code: z.string().optional(), message: z.string() })

/**
 * A save `save_to_downloads` refused. `code` is the stable reason {@link saveErrorMessage} maps to the user's words;
 * the message is the platform's text, for the console.
 */
export class SaveError extends Error {
  readonly code: string | undefined

  constructor(code: string | undefined, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SaveError'
    this.code = code
  }
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
    // Both sides reject with a plain `{ code, message }`, which callers' `String(error)` shows as "[object Object]".
    const rejection = nativeRejection.safeParse(error)
    throw rejection.success
      ? new SaveError(rejection.data.code, rejection.data.message, { cause: error })
      : new SaveError(undefined, String(error), { cause: error })
  }
}

/** A file a phone saved. Phones show no download bar, so the app says where it went. */
export type MobileSave = { name: string; platform: 'ios' | 'android' }

const mobileSaveListeners = new Set<(save: MobileSave) => void>()

/** Call `listener` after each native save on a phone. Returns the unsubscribe. */
export const subscribeToMobileSaves = (listener: (save: MobileSave) => void): (() => void) => {
  mobileSaveListeners.add(listener)
  return () => {
    mobileSaveListeners.delete(listener)
  }
}

const saveNatively = async (request: DownloadRequest, { platform, fs, invoke }: DownloadNative): Promise<string> => {
  const name = await (platform === 'ios' ? saveToDocuments(request, fs) : saveToDownloads(request, invoke))
  if (platform === 'ios' || platform === 'android') {
    mobileSaveListeners.forEach((listener) => listener({ name, platform }))
  }
  return name
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
 * The name is made safe first, the same on every platform: no bidirectional
 * controls that disguise the extension, and none of the characters Windows
 * refuses, such as the `:` in `Meeting 10:30.docx`.
 *
 * Throws on failure rather than reporting it, so the caller decides what the
 * user sees, through {@link saveErrorMessage}. Silence is the one thing this must not do.
 *
 * `native` lets tests run the Tauri branches, which are the ones that had the
 * bugs: `plugin-fs`, the platform and the native command mean nothing outside
 * the webview.
 */
export const downloadFile = async (request: DownloadRequest, native?: DownloadNative): Promise<string> => {
  const safe = { ...request, name: safeFileNameString(request.name) }
  if (native) {
    return saveNatively(safe, native)
  }
  return isTauri() ? saveNatively(safe, await loadNative()) : saveViaBrowser(safe)
}

const namesTaken = msg`Too many files with this name are already in the folder. Rename or move some of them, then try again.`
const noFolder = msg`The folder to save into does not exist.`

/** The reasons `save_to_downloads` (Rust and Kotlin) rejects with, by their stable code. */
const saveErrorCodes = new Map<string, MessageDescriptor>([
  ['names_taken', namesTaken],
  [
    'mark_failed',
    msg`The file could not be marked as downloaded from the internet, so it was not saved. The Downloads folder may be on a drive that cannot keep that mark.`,
  ],
  ['no_downloads_folder', noFolder],
  ['needs_android_10', msg`Saving files needs Android 10 or later.`],
])

/**
 * The OS texts behind errors nobody gave a code: a `write_failed` save, and plugin-fs on iOS. They name internal paths
 * and OS error numbers, so they go to the console and the user gets the reason they stand for.
 */
const osErrorReasons: [RegExp, MessageDescriptor][] = [
  [/os error 17\b|file exists/i, namesTaken],
  [/os error (28|112)\b|no space left|not enough space/i, msg`There is not enough free space on this device.`],
  [/os error (2|3)\b|no such file|cannot find the path/i, noFolder],
  [
    /os error (1|5|13|30)\b|permission denied|access is denied|forbidden path|read-only/i,
    msg`Thunderbolt is not allowed to save there.`,
  ],
]

/**
 * Why a save from {@link downloadFile} failed, in plain words; resolve it with `i18n._`. Takes the caught error, or
 * its text when something threw a non-`Error`.
 */
export const saveErrorMessage = (error: Error | string): MessageDescriptor => {
  const coded = error instanceof SaveError && error.code ? saveErrorCodes.get(error.code) : undefined
  if (coded) {
    return coded
  }
  const message = error instanceof Error ? error.message : error
  return (
    osErrorReasons.find(([pattern]) => pattern.test(message))?.[1] ?? msg`Something went wrong while saving the file.`
  )
}
