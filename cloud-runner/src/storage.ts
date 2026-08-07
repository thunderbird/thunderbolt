/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The runner's on-disk footprint and the erasure/retention operations over it.
 *
 * Two trees hold everything a session owns: the workspace jail its tools are
 * confined to (`<dataDir>/workspaces/<userId>/<sessionId>`) and Pi's JSONL
 * entry log, whose directory name Pi derives from the workspace path through a
 * private encoding. That encoding is deliberately not reimplemented here —
 * logs are located through the session repo's public `list` API instead.
 *
 * Deletion here is a hard delete by design: it is the privacy-erasure path
 * (thread deleted in the app, account deleted, retention window elapsed), and
 * a tombstone would defeat the point.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'

export type SessionStorage = {
  /** Absolute workspace jail for one session. */
  workspaceDir: (userId: string, sessionId: string) => string
  /** Hard-delete one session's workspace and entry log. Resolves `false` when
   *  the session had nothing on disk (unknown, or another user's). */
  deleteSession: (userId: string, sessionId: string) => Promise<boolean>
  /** Hard-delete every workspace and entry log owned by `userId`. */
  deleteUser: (userId: string) => Promise<void>
  /** Hard-delete sessions whose entry log has not been appended to since
   *  `cutoffMs` and that hold no live runtime. Resolves how many were removed. */
  purgeExpired: (cutoffMs: number, isLive: (sessionId: string) => boolean) => Promise<number>
}

/** Last-modified time of `path` in epoch ms, or `null` when it does not exist. */
const modifiedAt = async (path: string): Promise<number | null> => {
  const info = await stat(path).catch(() => null)
  return info?.mtimeMs ?? null
}

/**
 * Open the runner's data directory for path resolution and erasure.
 *
 * @param dataDir - root holding the `sessions` and `workspaces` trees
 */
export const createSessionStorage = (dataDir: string): SessionStorage => {
  const sessionsRoot = join(dataDir, 'sessions')
  const workspacesRoot = join(dataDir, 'workspaces')
  // The CLI's SessionStore exposes only create/open, so erasure needs its own
  // handle on the same root. The repo is stateless over the directory.
  const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })

  const workspaceDir = (userId: string, sessionId: string): string => join(workspacesRoot, userId, sessionId)

  /** Directory Pi keeps a workspace's entry logs in, `null` when it has none. */
  const logDirFor = async (cwd: string): Promise<string | null> => {
    const [meta] = await repo.list({ cwd })
    return meta ? dirname(meta.path) : null
  }

  const remove = async (cwd: string, logDir: string | null): Promise<void> => {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      logDir ? rm(logDir, { recursive: true, force: true }) : Promise.resolve(),
    ])
  }

  const deleteSession = async (userId: string, sessionId: string): Promise<boolean> => {
    const cwd = workspaceDir(userId, sessionId)
    const logDir = await logDirFor(cwd)
    const existed = logDir !== null || (await modifiedAt(cwd)) !== null
    await remove(cwd, logDir)
    return existed
  }

  return {
    workspaceDir,
    deleteSession,
    deleteUser: async (userId) => {
      const userDir = join(workspacesRoot, userId)
      // A user with no workspaces has no logs either — nothing to erase.
      const sessionIds = await readdir(userDir).catch(() => [])
      await Promise.all(sessionIds.map((sessionId) => deleteSession(userId, sessionId)))
      await rm(userDir, { recursive: true, force: true })
    },
    purgeExpired: async (cutoffMs, isLive) => {
      const owned = (await repo.list()).filter(
        (meta) => !isLive(meta.id) && meta.cwd.startsWith(`${workspacesRoot}${sep}`),
      )
      const dated = await Promise.all(owned.map(async (meta) => ({ meta, touchedAt: await modifiedAt(meta.path) })))
      const expired = dated.filter(({ touchedAt }) => touchedAt !== null && touchedAt < cutoffMs)
      await Promise.all(expired.map(({ meta }) => remove(meta.cwd, dirname(meta.path))))
      return expired.length
    },
  }
}
