/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { getPlatform } from './platform'

/** Types for binary files, which arrive untyped when read by path. Text and Office types come from the name later. */
const binaryTypes = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

/**
 * A file the OS handed over by path. Its name, type and size are known before
 * its bytes are read; `read` resolves to null when the OS refuses the read.
 */
export type PathFile = Pick<File, 'name' | 'type' | 'size'> & { read: () => Promise<File | null> }

type FileSystem = {
  stat: (path: string) => Promise<{ isFile: boolean; size: number }>
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
}

// Loaded on use, as `fs.ts` and `download.ts` do, so the chat's entry bundle does not carry the file system plugin.
const tauriFs: FileSystem = {
  stat: async (path) => (await import('@tauri-apps/plugin-fs')).stat(path),
  readFile: async (path) => (await import('@tauri-apps/plugin-fs')).readFile(path),
}

/**
 * True on Linux, where WebKitGTK shows a file dragged or copied from the OS
 * only as `text/uri-list` text, so the app reads it by path instead.
 */
export const readsFilesByPath = (): boolean => getPlatform() === 'linux'

/** The http and https URLs among URIs the OS handed over, such as a link dragged or copied from a browser. */
export const httpLinks = (uris: string[]): string[] => uris.filter((uri) => /^https?:\/\//i.test(uri))

/**
 * The regular files among the paths a native drag handed over, without
 * reading their bytes. A path it cannot stat is
 * left out. The app opens only regular files to the file system plugin, so
 * folders, devices and pipes are left out too.
 */
export const filesAtPaths = async (paths: string[], fs: FileSystem = tauriFs): Promise<PathFile[]> => {
  const infos = await Promise.allSettled(paths.map((path) => fs.stat(path)))
  return paths.flatMap((path, index) => {
    const info = infos[index]
    if (info.status === 'rejected' || !info.value.isFile) {
      return []
    }
    return [pathFile(path, path.slice(path.lastIndexOf('/') + 1), info.value.size, fs.readFile)]
  })
}

/** A file at `path`, typed from its name, whose bytes come from `readBytes` only when the caller reads it. */
const pathFile = (
  path: string,
  name: string,
  size: number,
  readBytes: (path: string) => Promise<Uint8Array<ArrayBuffer> | ArrayBuffer>,
): PathFile => {
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? ''
  const type = binaryTypes.get(extension) ?? ''
  const read = async () => {
    try {
      return new File([await readBytes(path)], name, { type })
    } catch (error) {
      console.error(`Failed to read ${path}:`, error)
      return null
    }
  }
  return { name, type, size, read }
}

/** A regular file a file manager copied, as `copied_files` in `platform_utils.rs` lists it. */
type CopiedFile = { path: string; name: string; size: number }

/** The two `platform_utils.rs` commands behind a file manager copy, so a test can supply them. */
export type CopiedFilesNative = {
  list: () => Promise<CopiedFile[]>
  read: (path: string) => Promise<ArrayBuffer>
}

const tauriCopiedFiles: CopiedFilesNative = {
  list: () => invoke<CopiedFile[]>('plugin:platform-utils|copied_files'),
  read: (path) => invoke<ArrayBuffer>('plugin:platform-utils|read_copied_file', { path }),
}

/**
 * The files a file manager copied, found through the OS clipboard. Listing them grants nothing: each file's bytes
 * come from `read_copied_file` when the composer reads it, which refuses any path the listing did not name and any
 * file over the composer's size cap.
 */
export const readCopiedFiles = async (native: CopiedFilesNative = tauriCopiedFiles): Promise<PathFile[]> =>
  (await native.list()).map(({ path, name, size }) => pathFile(path, name, size, native.read))
