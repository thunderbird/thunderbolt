/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../../cli/src/acp/session-store.ts'
import { createSessionStorage } from './storage.ts'

/** Seed a session exactly as the runner does: workspace jail + Pi entry log. */
const seedSession = async (dataDir: string, userId: string, sessionId: string): Promise<string> => {
  const storage = createSessionStorage(dataDir)
  const workspaceDir = storage.workspaceDir(userId, sessionId)
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(workspaceDir, 'note.txt'), 'work in progress')
  await createSessionStore(join(dataDir, 'sessions')).createSession(sessionId, workspaceDir)
  return workspaceDir
}

/** Every `.jsonl` entry log under the data dir, by session id. */
const logIdsIn = async (dataDir: string): Promise<string[]> => {
  const glob = new Bun.Glob('sessions/**/*.jsonl')
  const files = await Array.fromAsync(glob.scan({ cwd: dataDir }))
  return files.map((file) => file.replace(/^.*_/, '').replace(/\.jsonl$/, '')).sort()
}

const exists = (path: string): Promise<boolean> => Bun.file(path).exists()

describe('SessionStorage', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tb-cloud-storage-test-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  test('deleteSession removes the workspace and the entry log', async () => {
    const storage = createSessionStorage(dataDir)
    const sessionId = crypto.randomUUID()
    const other = crypto.randomUUID()
    const workspaceDir = await seedSession(dataDir, 'user-a', sessionId)
    await seedSession(dataDir, 'user-a', other)

    expect(await storage.deleteSession('user-a', sessionId)).toBe(true)
    expect(await exists(join(workspaceDir, 'note.txt'))).toBe(false)
    expect(await logIdsIn(dataDir)).toEqual([other])
  })

  test('deleteSession reports nothing erased for an unknown or foreign session', async () => {
    const storage = createSessionStorage(dataDir)
    const sessionId = crypto.randomUUID()
    await seedSession(dataDir, 'user-a', sessionId)

    expect(await storage.deleteSession('user-b', sessionId)).toBe(false)
    expect(await storage.deleteSession('user-a', crypto.randomUUID())).toBe(false)
    expect(await logIdsIn(dataDir)).toEqual([sessionId])
  })

  test('deleteUser erases every session that user owns and no one else’s', async () => {
    const storage = createSessionStorage(dataDir)
    const mine = [crypto.randomUUID(), crypto.randomUUID()]
    const theirs = crypto.randomUUID()
    for (const sessionId of mine) await seedSession(dataDir, 'user-a', sessionId)
    await seedSession(dataDir, 'user-b', theirs)

    await storage.deleteUser('user-a')
    expect(await exists(join(dataDir, 'workspaces', 'user-a'))).toBe(false)
    expect(await logIdsIn(dataDir)).toEqual([theirs])
  })

  test('purgeExpired erases only sessions untouched since the cutoff and not live', async () => {
    const storage = createSessionStorage(dataDir)
    const stale = crypto.randomUUID()
    const staleButLive = crypto.randomUUID()
    const fresh = crypto.randomUUID()
    for (const sessionId of [stale, staleButLive, fresh]) await seedSession(dataDir, 'user-a', sessionId)

    const long = new Date(Date.now() - 60 * 60 * 1000)
    const glob = new Bun.Glob('sessions/**/*.jsonl')
    for (const file of await Array.fromAsync(glob.scan({ cwd: dataDir }))) {
      if (!file.includes(fresh)) await utimes(join(dataDir, file), long, long)
    }

    const purged = await storage.purgeExpired(Date.now() - 60_000, (sessionId) => sessionId === staleButLive)
    expect(purged).toBe(1)
    expect(await logIdsIn(dataDir)).toEqual([fresh, staleButLive].sort())
    expect(await exists(join(dataDir, 'workspaces', 'user-a', stale))).toBe(false)
  })
})
