/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BrowserExecutionEnv } from './browser-env/browser-execution-env.ts'

export type WorkspaceEntry =
  | { readonly path: string; readonly kind: 'directory' }
  | { readonly path: string; readonly kind: 'file'; readonly base64: string; readonly byteCount: number }

export type WorkspaceSnapshot = { readonly version: 1; readonly entries: readonly WorkspaceEntry[] }

/** A platform store must atomically replace one isolated thread snapshot per save. */
export type WorkspaceStore = {
  load: (threadId: string) => Promise<WorkspaceSnapshot | undefined>
  save: (threadId: string, snapshot: WorkspaceSnapshot) => Promise<void>
  remove?: (threadId: string) => Promise<void>
}

export const workspaceSnapshotLimits = {
  maxEntries: 4_096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
} as const

/** Read a workspace into a bounded, binary-safe snapshot suitable for native storage. */
export const readWorkspaceSnapshot = async (
  env: BrowserExecutionEnv,
  workspaceDir: string,
): Promise<WorkspaceSnapshot> => {
  const entries: WorkspaceEntry[] = []
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    const listed = await env.listDir(directory)
    if (!listed.ok) {
      throw listed.error
    }
    for (const child of listed.value.sort((left, right) => left.path.localeCompare(right.path))) {
      const path = relativeWorkspacePath(workspaceDir, child.path)
      if (child.kind === 'directory') {
        entries.push({ path, kind: 'directory' })
        assertEntryLimit(entries.length)
        await visit(child.path)
        continue
      }
      if (child.kind !== 'file') {
        throw new Error(`Unsupported workspace entry kind: ${child.kind}`)
      }
      if (child.size > workspaceSnapshotLimits.maxFileBytes) {
        throw new Error(`Workspace file exceeds ${workspaceSnapshotLimits.maxFileBytes} bytes: ${path}`)
      }
      totalBytes += child.size
      if (totalBytes > workspaceSnapshotLimits.maxTotalBytes) {
        throw new Error(`Workspace exceeds ${workspaceSnapshotLimits.maxTotalBytes} bytes`)
      }
      const read = await env.readBinaryFile(child.path)
      if (!read.ok) {
        throw read.error
      }
      entries.push({
        path,
        kind: 'file',
        base64: Buffer.from(read.value).toString('base64'),
        byteCount: read.value.byteLength,
      })
      assertEntryLimit(entries.length)
    }
  }
  await visit(workspaceDir)
  return { version: 1, entries }
}

/** Restore a validated snapshot into a newly-created workspace directory. */
export const restoreWorkspaceSnapshot = async (
  env: BrowserExecutionEnv,
  workspaceDir: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> => {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {
    throw new Error('Unsupported workspace snapshot')
  }
  validateSnapshotBounds(snapshot)
  for (const entry of snapshot.entries) {
    const kind = (entry as WorkspaceEntry & { kind: string }).kind
    const destination = resolveSnapshotPath(workspaceDir, entry.path)
    if (kind === 'directory') {
      const created = await env.createDir(destination, { recursive: true })
      if (!created.ok) {
        throw created.error
      }
      continue
    }
    if (kind !== 'file' || typeof entry.base64 !== 'string') {
      throw new Error('Invalid workspace file snapshot')
    }
    const bytes = Buffer.from(entry.base64, 'base64')
    if (bytes.byteLength !== entry.byteCount) {
      throw new Error(`Invalid byte count in workspace snapshot: ${entry.path}`)
    }
    const written = await env.writeFile(destination, bytes)
    if (!written.ok) {
      throw written.error
    }
  }
}

const assertEntryLimit = (count: number): void => {
  if (count > workspaceSnapshotLimits.maxEntries) {
    throw new Error(`Workspace exceeds ${workspaceSnapshotLimits.maxEntries} entries`)
  }
}

const validateSnapshotBounds = (snapshot: WorkspaceSnapshot): void => {
  assertEntryLimit(snapshot.entries.length)
  let totalBytes = 0
  const paths = new Set<string>()
  for (const entry of snapshot.entries) {
    if (paths.has(entry.path)) {
      throw new Error(`Duplicate workspace path: ${entry.path}`)
    }
    paths.add(entry.path)
    resolveSnapshotPath('/workspace/thread', entry.path)
    const kind = (entry as WorkspaceEntry & { kind: string }).kind
    if (kind === 'file') {
      const byteCount = (entry as Extract<WorkspaceEntry, { kind: 'file' }>).byteCount
      if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > workspaceSnapshotLimits.maxFileBytes) {
        throw new Error(`Invalid workspace file size: ${entry.path}`)
      }
      totalBytes += byteCount
    } else if (kind !== 'directory') {
      throw new Error(`Invalid workspace entry kind: ${kind}`)
    }
  }
  if (totalBytes > workspaceSnapshotLimits.maxTotalBytes) {
    throw new Error(`Workspace exceeds ${workspaceSnapshotLimits.maxTotalBytes} bytes`)
  }
}

const relativeWorkspacePath = (root: string, absolute: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!absolute.startsWith(prefix)) {
    throw new Error(`Workspace entry escaped its root: ${absolute}`)
  }
  return absolute.slice(prefix.length)
}

const resolveSnapshotPath = (root: string, path: string): string => {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid workspace snapshot path: ${path}`)
  }
  return `${root}/${path}`
}
