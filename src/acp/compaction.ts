/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk'

/** Agent-owned presentation state. Never used to reconstruct the model's context. */
export type AcpCompaction = {
  agentId: string
  sessionId: string
  compactionId: string
  status: string
  summary?: ContentBlock[] | null
  error?: string | null
  _meta?: Record<string, unknown> | null
}

/** Current context-window usage, independent of billable token counts. */
export type AcpContextUsage = { agentId: string; sessionId: string; used: number; size: number }

export type AcpSessionEvent =
  | { type: 'compaction'; compaction: AcpCompaction }
  | { type: 'usage'; usage: AcpContextUsage }

/** Scope opaque compaction IDs to their owning session, without delimiter collisions. */
export const acpCompactionKey = (compaction: Pick<AcpCompaction, 'agentId' | 'sessionId' | 'compactionId'>): string =>
  JSON.stringify([compaction.agentId, compaction.sessionId, compaction.compactionId])

export type AcpCompactionUpdate = Extract<
  SessionNotification['update'],
  { sessionUpdate: 'compaction_update' | 'compaction_summary_chunk' }
>

/** Apply ACP's replacement patches and append-only chunks without resetting omitted fields. */
export const applyAcpCompactionUpdate = (
  agentId: string,
  sessionId: string,
  update: AcpCompactionUpdate,
  previous?: AcpCompaction,
): AcpCompaction => {
  const current = previous ?? { agentId, sessionId, compactionId: update.compactionId, status: 'in_progress' }
  if (update.sessionUpdate === 'compaction_summary_chunk') {
    return { ...current, summary: [...(current.summary ?? []), update.content] }
  }
  return {
    ...current,
    status: update.status,
    ...(update.summary !== undefined ? { summary: update.summary } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
    ...(update._meta !== undefined ? { _meta: update._meta } : {}),
  }
}
