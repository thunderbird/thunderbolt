/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { acpCompactionKey, type AcpCompaction, type AcpSessionEvent } from '@/acp/compaction'
import type { ThunderboltUIMessage } from '@/types'
import { v7 as uuidv7 } from 'uuid'

/** Restore presentation entities without exposing them as agent execution checkpoints. */
export const getAcpCompactions = (messages: ThunderboltUIMessage[]): AcpCompaction[] =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'data-acp-compaction' ? [part.data] : [])),
  )

/** Patch existing entities in place; new live entities belong to the active SSE stream. */
export const applyAcpSessionEvent = (
  messages: ThunderboltUIMessage[],
  event: AcpSessionEvent,
  inPrompt: boolean,
): { messages: ThunderboltUIMessage[]; changed: ThunderboltUIMessage } | undefined => {
  if (event.type === 'usage') {
    const last = messages.at(-1)
    if (inPrompt || !last) {
      return undefined
    }
    const changed = {
      ...last,
      metadata: { ...last.metadata, acpContextUsage: event.usage, contextTokens: event.usage.used },
    }
    return { messages: [...messages.slice(0, -1), changed], changed }
  }

  const key = acpCompactionKey(event.compaction)
  const index = messages.findIndex((message) =>
    message.parts.some((part) => part.type === 'data-acp-compaction' && acpCompactionKey(part.data) === key),
  )
  // The SDK owns its streaming message and patches data parts by id itself.
  if (inPrompt && (index < 0 || index === messages.length - 1)) {
    return undefined
  }
  const part = { type: 'data-acp-compaction' as const, id: key, data: event.compaction }
  if (index < 0) {
    const changed: ThunderboltUIMessage = { id: uuidv7(), role: 'assistant', parts: [part] }
    return { messages: [...messages, changed], changed }
  }
  const original = messages[index]
  const changed: ThunderboltUIMessage = {
    ...original,
    parts: original.parts.map((previous) =>
      previous.type === 'data-acp-compaction' && acpCompactionKey(previous.data) === key ? part : previous,
    ),
  }
  return { messages: messages.map((message, i) => (i === index ? changed : message)), changed }
}
