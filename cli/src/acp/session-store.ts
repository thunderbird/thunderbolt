/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Disk-backed store for the ACP server's per-session Pi entry logs, keyed by the
 * agent-issued `sessionId`.
 *
 * The bridge spawns a fresh `acp serve` process per connection and kills it on
 * disconnect, so in-memory session state cannot survive a reconnect. Persisting
 * each session's Pi entry log to disk on the bridge machine — exactly where the
 * workspace files it describes live — lets a fresh process rehydrate the agent's
 * full execution context (messages, tool calls/results, compaction) on
 * `session/resume`. This mirrors Claude Code / Codex: sessions are keyed to the
 * machine + cwd, and cross-machine resume is intentionally unsupported.
 *
 * Backed by Pi's {@link JsonlSessionRepo}, which needs a {@link FileSystem}; the
 * only Node one Pi exports is {@link NodeExecutionEnv}. We hold a single,
 * process-lifetime env whose lifetime outlives every per-session workspace env
 * (those are disposed on session teardown, but the store's fs is captured for
 * every append during a turn, so it must not be torn down with them).
 */

import { join } from 'node:path'
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import type { Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { thunderboltHomeDir } from '../paths.ts'

/** Creates and resumes disk-backed Pi sessions for ACP session ids. */
export type SessionStore = {
  /** Mint a fresh on-disk session log under `id` for `session/new`. */
  createSession: (id: string, cwd: string) => Promise<Session>
  /** Resume by `id` for `session/resume`: open existing log and trim any
   *  incomplete trailing turn. Reject missing logs so client can create and
   *  transcript-seed a genuinely new session. */
  openSession: (id: string, cwd: string) => Promise<Session>
}

/** Default on-disk root for persisted ACP sessions on the bridge machine. */
export const defaultSessionsDir = (): string => join(thunderboltHomeDir(), 'acp', 'sessions')

/**
 * Trim a trailing incomplete turn from a just-opened session so the next prompt
 * starts from a clean assistant boundary.
 *
 * The bridge SIGTERMs the serve process on disconnect, so a kill can land
 * mid-turn — leaving the log ending on an assistant `tool_use` whose
 * `tool_result` was never written, or a bare user prompt with no response.
 * Either shape makes the model API reject the next appended user message. We
 * walk the active branch, track unresolved `tool_use` ids, and move the leaf
 * back to the last entry after which the conversation was a complete assistant
 * turn (or empty). Non-destructive: dropped entries stay in the JSONL, just off
 * the active branch.
 *
 * We deliberately anchor on the last *assistant* boundary rather than any clean
 * entry: it guarantees valid role alternation for the next prompt. The one cost
 * is that a kill during the turn immediately after a compaction rewinds past that
 * compaction entry, re-expanding the pre-compaction history — which pi's
 * prompt-time overflow compaction re-collapses on the next turn (a rare, self-
 * healing case; a special compact-on-resume path is intentionally not built).
 */
const sanitizeResumedTail = async (session: Session): Promise<void> => {
  const branch = await session.getBranch()
  const unresolved = new Set<string>()
  // `null` marks "the empty prefix is a clean boundary" — used when no complete
  // assistant turn precedes the incomplete tail.
  let cleanBoundaryId: string | null = null
  let lastMessageId: string | null = null

  for (const entry of branch) {
    if (entry.type !== 'message') continue
    lastMessageId = entry.id
    const message = entry.message
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') unresolved.add(block.id)
      }
      // A complete assistant turn = every prior tool call answered. A user turn
      // awaiting a response is never itself a clean boundary.
      if (unresolved.size === 0) cleanBoundaryId = entry.id
    } else if (message.role === 'toolResult') {
      unresolved.delete(message.toolCallId)
    }
  }

  if (lastMessageId !== cleanBoundaryId) await session.moveTo(cleanBoundaryId)
}

/**
 * Build the process-lifetime session store rooted at `sessionsDir`. The repo
 * namespaces files as `<sessionsDir>/<encodedCwd>/<timestamp>_<id>.jsonl`
 * itself, and self-creates the directory tree on first write.
 *
 * @param sessionsDir - absolute root directory for persisted session logs
 */
export const createSessionStore = (sessionsDir: string): SessionStore => {
  const fs = new NodeExecutionEnv({ cwd: sessionsDir })
  const repo = new JsonlSessionRepo({ fs, sessionsRoot: sessionsDir })

  return {
    createSession: (id, cwd) => repo.create({ id, cwd }),
    openSession: async (id, cwd) => {
      // `open` needs the full timestamped metadata, which only `list` yields —
      // the path can't be reconstructed from the id alone.
      const existing = (await repo.list({ cwd })).find((meta) => meta.id === id)
      if (!existing) {
        throw new Error(`no on-disk session '${id}' for workspace '${cwd}'`)
      }
      const session = await repo.open(existing)
      await sanitizeResumedTail(session)
      return session
    },
  }
}
