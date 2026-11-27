/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isRecord } from '@/lib/utils'
import { v5 as uuidv5 } from 'uuid'
import { chatExportKind } from './export'

/** The chat an import file holds, when it holds exactly one. */
export type ChatFileSummary = {
  title: string | null
  messageCount: number
}

/** The only tables a single-chat file writes. */
type ChatTables = { chat_threads: unknown[]; chat_messages: unknown[] }

const chatTableNames: ReadonlySet<string> = new Set(['chat_threads', 'chat_messages'] satisfies Array<keyof ChatTables>)

/** Fixed namespace for the ids an imported chat gets in another account. Changing it would duplicate re-imports. */
const chatImportNamespace = '067ecc91-ea3c-4250-9862-0630956daf59'

/** A uuid v7 (what the app gives chats and messages), whose first half encodes the time and so its sort order. */
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Characters of a uuid v7 holding its first 11 bytes: the timestamp, then the counter that orders ids made in the same
 * millisecond, which runs to the top of byte 10. The last 5 bytes are random, so only they are derived.
 */
const orderedPrefixLength = 26

/**
 * A new id for `id` under `ownerKey`, the same on every import. Messages are listed in id order, so a uuid v7 keeps
 * its time-ordered first half and only the rest is derived: the copy sorts exactly like the original, and before any
 * message written after the import. Any other id is derived whole.
 */
const ownedId = (ownerKey: string, id: string): string => {
  const derived = uuidv5(`${ownerKey}:${id}`, chatImportNamespace)
  return uuidV7.test(id) ? `${id.slice(0, orderedPrefixLength)}${derived.slice(orderedPrefixLength)}` : derived
}

const rowsOf = (tables: Record<string, unknown>, name: keyof ChatTables): unknown[] => {
  const rows = tables[name]
  return Array.isArray(rows) ? rows : []
}

/**
 * Recognizes a file holding one chat: exactly one thread, and every message belongs to it. A file marked
 * `kind: 'chat'` may carry other tables (a later format may add some), which the import ignores; an unmarked one (an
 * older or hand-made file) must hold nothing else, so a full backup is never taken for a chat.
 */
export const detectChatImport = (tables: Record<string, unknown>, kind: unknown): ChatFileSummary | null => {
  const isOnlyChat = Object.entries(tables).every(
    ([name, rows]) => chatTableNames.has(name) || (Array.isArray(rows) && rows.length === 0),
  )
  if (kind !== chatExportKind && !isOnlyChat) {
    return null
  }
  const threads = rowsOf(tables, 'chat_threads')
  const [thread] = threads
  if (threads.length !== 1 || !isRecord(thread) || typeof thread.id !== 'string') {
    return null
  }
  const messages = rowsOf(tables, 'chat_messages')
  if (!messages.every((message) => isRecord(message) && message.chatThreadId === thread.id)) {
    return null
  }
  return { title: typeof thread.title === 'string' ? thread.title : null, messageCount: messages.length }
}

/** Just the chat of a file {@link detectChatImport} accepted, without any other table it carries. */
export const chatTablesOf = (tables: Record<string, unknown>): ChatTables => ({
  chat_threads: rowsOf(tables, 'chat_threads'),
  chat_messages: rowsOf(tables, 'chat_messages'),
})

/**
 * The chat of a file {@link detectChatImport} accepted, under ids of its own. The backend matches chat rows on `id`
 * alone and only lets the owner update them, so another account's ids would be dropped on upload. Each id is derived
 * from `ownerKey` (the importing user, or this device when signed out) and the original id, keeping the original's
 * sort order (see {@link ownedId}), so importing the same file again under the same key updates the copy. A different key (after signing in, or a new device id after
 * signing out) makes another copy.
 *
 * The project and ACP session belong to the other account, so the thread drops them.
 */
export const rekeyChat = (tables: Record<string, unknown>, ownerKey: string): ChatTables => {
  const rekey = (id: unknown) => (typeof id === 'string' ? ownedId(ownerKey, id) : id)
  const { chat_threads: threads, chat_messages: messages } = chatTablesOf(tables)
  return {
    chat_threads: threads.filter(isRecord).map((thread) => ({
      ...thread,
      id: rekey(thread.id),
      projectId: null,
      acpSessionId: null,
    })),
    chat_messages: messages.filter(isRecord).map((message) => ({
      ...message,
      id: rekey(message.id),
      chatThreadId: rekey(message.chatThreadId),
      parentId: rekey(message.parentId),
    })),
  }
}
