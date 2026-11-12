/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import { BrowserExecutionEnv } from './browser-env/browser-execution-env.ts'
import { mountInMemoryFs } from './browser-env/mount.ts'
import {
  readWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
  workspaceSnapshotLimits,
  type WorkspaceSnapshot,
} from './workspace-store.ts'

const workspaceDir = '/workspace/persisted-thread'

beforeAll(async () => {
  await mountInMemoryFs()
})

beforeEach(async () => {
  await fsp.rm('/workspace', { recursive: true, force: true })
  await fsp.mkdir(workspaceDir, { recursive: true })
})

describe('workspace snapshots', () => {
  it('round trips nested directories and binary files', async () => {
    const source = new BrowserExecutionEnv({ cwd: workspaceDir })
    await fsp.mkdir(`${workspaceDir}/empty`, { recursive: true })
    await fsp.mkdir(`${workspaceDir}/data`, { recursive: true })
    await fsp.writeFile(`${workspaceDir}/data/value.bin`, new Uint8Array([0, 1, 127, 128, 255]))

    const snapshot = await readWorkspaceSnapshot(source, workspaceDir)
    await fsp.rm(workspaceDir, { recursive: true, force: true })
    await fsp.mkdir(workspaceDir, { recursive: true })
    const restored = new BrowserExecutionEnv({ cwd: workspaceDir })
    await restoreWorkspaceSnapshot(restored, workspaceDir, snapshot)

    expect(await fsp.readdir(`${workspaceDir}/empty`)).toEqual([])
    expect([...(await fsp.readFile(`${workspaceDir}/data/value.bin`))]).toEqual([0, 1, 127, 128, 255])
  })

  it('rejects traversal and absolute snapshot paths before writing', async () => {
    const env = new BrowserExecutionEnv({ cwd: workspaceDir })
    const snapshots: WorkspaceSnapshot[] = [
      { version: 1, entries: [{ path: '../secret', kind: 'file', base64: 'eA==', byteCount: 1 }] },
      { version: 1, entries: [{ path: '/secret', kind: 'directory' }] },
    ]
    for (const snapshot of snapshots) {
      await expect(restoreWorkspaceSnapshot(env, workspaceDir, snapshot)).rejects.toThrow(
        /Invalid workspace snapshot path/,
      )
    }
    expect(await fsp.exists('/workspace/secret')).toBe(false)
  })

  it('rejects snapshots beyond the per-file and total byte limits', async () => {
    const env = new BrowserExecutionEnv({ cwd: workspaceDir })
    const oversizedFile: WorkspaceSnapshot = {
      version: 1,
      entries: [{ path: 'large.bin', kind: 'file', base64: '', byteCount: workspaceSnapshotLimits.maxFileBytes + 1 }],
    }
    const oversizedTotal: WorkspaceSnapshot = {
      version: 1,
      entries: Array.from({ length: 5 }, (_, index) => ({
        path: `file-${index}`,
        kind: 'file' as const,
        base64: '',
        byteCount: workspaceSnapshotLimits.maxFileBytes,
      })),
    }
    await expect(restoreWorkspaceSnapshot(env, workspaceDir, oversizedFile)).rejects.toThrow(
      /Invalid workspace file size/,
    )
    await expect(restoreWorkspaceSnapshot(env, workspaceDir, oversizedTotal)).rejects.toThrow(/Workspace exceeds/)
  })

  it('rejects a snapshot whose declared byte count does not match its encoded bytes', async () => {
    const env = new BrowserExecutionEnv({ cwd: workspaceDir })
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      entries: [{ path: 'bad.bin', kind: 'file', base64: 'eA==', byteCount: 2 }],
    }
    await expect(restoreWorkspaceSnapshot(env, workspaceDir, snapshot)).rejects.toThrow(/Invalid byte count/)
    expect(await fsp.exists(`${workspaceDir}/bad.bin`)).toBe(false)
  })
})
