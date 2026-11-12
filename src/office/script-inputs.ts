/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WorkspaceFileRead } from '@shared/agent-core'
import type { StoredFile } from '@/lib/file-blob-storage'
import type { SandboxInput } from './sandbox'

/** Reads a file from the agent's workspace by its workspace-relative path, refusing one over `maxBytes` unread. */
export type ReadWorkspaceFile = (path: string, maxBytes: number) => Promise<WorkspaceFileRead>

export type ResolvedInputs = { ok: true; inputs: SandboxInput[]; filenames: string[] } | { ok: false; error: string }

/** Newest first; between two files stored at the same moment, the later one in the thread comes first. */
const newestFirst = (files: StoredFile[]) => [...files].reverse().sort((a, b) => b.createdAt - a.createdAt)

/** The file with this id, else the newest file with this name. */
const findStored = (files: StoredFile[], reference: string) =>
  files.find(({ id }) => id === reference) ?? newestFirst(files).find(({ filename }) => filename === reference)

const readStored = async (file: StoredFile, maxBytes: number): Promise<WorkspaceFileRead> =>
  file.blob.size > maxBytes
    ? { status: 'too-large' }
    : { status: 'read', bytes: new Uint8Array(await file.blob.arrayBuffer()) }

const notFound = (name: string, files: StoredFile[], hasWorkspace: boolean) => {
  const listed = newestFirst(files)
    .map(({ filename, id }) => `"${filename}" (id ${id})`)
    .join(', ')
  const known = listed ? `The files in this chat, newest first: ${listed}.` : 'This chat has no files.'
  return hasWorkspace
    ? `No file "${name}" in this chat or in your workspace. ${known} Name an input by its file name, its id, or its path in your workspace.`
    : `No file "${name}" in this chat. ${known} Name an input by its file name or its id.`
}

/**
 * Find the bytes of each input the script named: first among the chat's stored files, by id or by name (the
 * newest wins), then in the agent's workspace when there is one. A file that would take the inputs past
 * `maxBytes` is refused before it is read. `filenames` holds each input's file name, so a saved file can be
 * recognised as an edited copy.
 */
export const resolveInputs = async (
  references: string[],
  files: StoredFile[],
  readWorkspaceFile: ReadWorkspaceFile | undefined,
  maxBytes: number,
): Promise<ResolvedInputs> => {
  const inputs: SandboxInput[] = []
  const filenames: string[] = []
  let remainingBytes = maxBytes
  for (const name of new Set(references)) {
    const stored = findStored(files, name)
    const found: WorkspaceFileRead = stored
      ? await readStored(stored, remainingBytes)
      : ((await readWorkspaceFile?.(name, remainingBytes)) ?? { status: 'missing' })
    if (found.status === 'missing') {
      return { ok: false, error: notFound(name, files, readWorkspaceFile !== undefined) }
    }
    if (found.status === 'too-large') {
      return {
        ok: false,
        error: `The inputs add up to more than ${maxBytes / 1024 / 1024} MiB. Read fewer or smaller files in one run.`,
      }
    }
    remainingBytes -= found.bytes.byteLength
    inputs.push({ name, bytes: found.bytes })
    filenames.push(stored?.filename ?? name.slice(name.lastIndexOf('/') + 1))
  }
  return { ok: true, inputs, filenames }
}
