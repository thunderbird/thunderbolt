/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { parseArtifactId, toHtmlArtifact, type Artifact } from '@/artifacts/artifact'
import { isRenderHtmlPart } from '@/artifacts/render-html-tool'
import { renderHtmlToolName } from '@/artifacts/constants'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatMessagesTable, chatThreadsTable, settingsTable } from '@/db/tables'
import { updateSettings } from './settings'

const artifactPinPrefix = 'artifact-pin:'

export type ArtifactMessageRow = { id: string; chatThreadId: string | null; parts: unknown }
export type ArtifactPinRow = { key: string; value: string | null }
export type PresentedArtifactRow = ArtifactMessageRow & { deletedAt: string | null; chatDeletedAt: string | null }

/** Pins are preferences, not copies of content; one row per artifact preserves unrelated concurrent edits. */
export const artifactPinKey = (id: string): string => `${artifactPinPrefix}${id}`

/** Query source messages, excluding deleted chats and optionally restricting to known message IDs. */
export const getArtifactMessagesQuery = (db: AnyDrizzleDatabase, messageIds?: readonly string[]) =>
  db
    .select({ id: chatMessagesTable.id, chatThreadId: chatMessagesTable.chatThreadId, parts: chatMessagesTable.parts })
    .from(chatMessagesTable)
    .innerJoin(chatThreadsTable, eq(chatThreadsTable.id, chatMessagesTable.chatThreadId))
    .where(
      and(
        isNull(chatMessagesTable.deletedAt),
        isNull(chatThreadsTable.deletedAt),
        eq(chatMessagesTable.role, 'assistant'),
        sql`${chatMessagesTable.parts} LIKE ${`%${renderHtmlToolName}%`}`,
        messageIds === undefined
          ? undefined
          : messageIds.length > 0
            ? inArray(chatMessagesTable.id, [...messageIds])
            : sql`1=0`,
      ),
    )
    .orderBy(desc(chatMessagesTable.id))

/** Query pin preferences, optionally for a single artifact. False rows preserve an explicit unpin across sync. */
export const getArtifactPinsQuery = (db: AnyDrizzleDatabase, id?: string) =>
  db
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(
      id === undefined
        ? sql`${settingsTable.key} LIKE ${`${artifactPinPrefix}%`}`
        : eq(settingsTable.key, artifactPinKey(id)),
    )
    .orderBy(settingsTable.key)

/** Include tombstones when watching an already-open snapshot so a pending save differs from deletion. */
export const getPresentedArtifactQuery = (db: AnyDrizzleDatabase, messageId: string | null) =>
  db
    .select({
      id: chatMessagesTable.id,
      chatThreadId: chatMessagesTable.chatThreadId,
      parts: chatMessagesTable.parts,
      deletedAt: chatMessagesTable.deletedAt,
      chatDeletedAt: sql<string | null>`${chatThreadsTable.deletedAt}`.as('chat_deleted_at'),
    })
    .from(chatMessagesTable)
    .leftJoin(chatThreadsTable, eq(chatThreadsTable.id, chatMessagesTable.chatThreadId))
    .where(messageId === null ? sql`1=0` : eq(chatMessagesTable.id, messageId))

/** Read message JSON from either Drizzle's decoded value or PowerSync's raw string. */
const parseMessageParts = (value: unknown): UIMessage['parts'] => {
  try {
    const parts: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parts)) {
      return []
    }
    return parts.filter(
      (part): part is UIMessage['parts'][number] =>
        typeof part === 'object' && part !== null && 'type' in part && typeof part.type === 'string',
    )
  } catch {
    // Imported or partially synced malformed content must not take down the library.
    return []
  }
}

/** Resolve source rows without maintaining a second artifact content store. */
export const artifactsFromMessages = (rows: readonly ArtifactMessageRow[]): Artifact[] =>
  rows.flatMap((row) =>
    parseMessageParts(row.parts).flatMap((part) => {
      const artifact = toHtmlArtifact(row.id, row.chatThreadId, part)
      return artifact ? [artifact] : []
    }),
  )

/** Keep a verified, not-yet-saved snapshot until persistence provides a newer verdict or a tombstone. */
export const resolvePresentedArtifact = (
  snapshot: Artifact,
  row: PresentedArtifactRow | undefined,
): Artifact | null => {
  if (!row || snapshot.reference.kind !== 'html') {
    return snapshot
  }
  if (row.deletedAt !== null || row.chatDeletedAt !== null) {
    return null
  }
  const toolCallId = snapshot.reference.toolCallId
  const part = parseMessageParts(row.parts).find(
    (candidate) => isRenderHtmlPart(candidate) && candidate.toolCallId === toolCallId,
  )
  if (!part || !isRenderHtmlPart(part)) {
    return snapshot
  }
  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return snapshot
  }
  return toHtmlArtifact(row.id, row.chatThreadId, part)
}

/** Read only valid, explicitly pinned identities; malformed preferences cannot create renderable content. */
export const pinnedArtifactIds = (rows: readonly ArtifactPinRow[]): string[] =>
  rows.flatMap(({ key, value }) => {
    if (!key.startsWith(artifactPinPrefix) || value !== 'true') {
      return []
    }
    const id = key.slice(artifactPinPrefix.length)
    return parseArtifactId(id) ? [id] : []
  })

/** Read verified generated artifacts, newest messages first. */
export const getHtmlArtifacts = async (db: AnyDrizzleDatabase, messageIds?: readonly string[]): Promise<Artifact[]> =>
  artifactsFromMessages(await getArtifactMessagesQuery(db, messageIds))

/** Set a user's pin preference without rewriting messages or hard-deleting a synced row. */
export const setArtifactPinned = async (db: AnyDrizzleDatabase, id: string, pinned: boolean): Promise<void> => {
  if (!parseArtifactId(id)) {
    throw new Error('Invalid artifact identity')
  }
  await updateSettings(db, { [artifactPinKey(id)]: pinned })
}
