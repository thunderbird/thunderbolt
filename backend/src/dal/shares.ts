/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import {
  chatShareNotificationsTable,
  chatShareRecipientsTable,
  chatSharesTable,
  chatThreadsTable,
  receivedSharesTable,
  sentSharesTable,
  user,
} from '@/db/schema'
import type { ShareUser } from '@shared/chat-shares'
import { and, asc, eq, exists, inArray, isNull, notExists, notInArray, sql } from 'drizzle-orm'
import { getEncryptionMetadata, getLatestInboxKey, lockUserKeys } from './encryption'

/**
 * Join condition that keeps a share only while its source chat exists and is
 * not soft-deleted. Every read goes through it, so deleting a chat stops its
 * shares on every path at once, whichever device the delete came from.
 */
const liveSourceThread = and(
  eq(chatThreadsTable.id, chatSharesTable.chatThreadId),
  eq(chatThreadsTable.userId, chatSharesTable.ownerUserId),
  isNull(chatThreadsTable.deletedAt),
)

/**
 * A user's current inbox key: the newest version, and only while it is sealed
 * under the account's current primary DEK. Null when the account cannot receive
 * a share yet — no v2 encryption, no inbox key, or one gone stale after a
 * rotation that the next trusted device has not caught up with.
 */
export const getCurrentInboxKey = async (database: QueryableDatabase, userId: string) => {
  const [metadata, latest] = await Promise.all([
    getEncryptionMetadata(database, userId),
    getLatestInboxKey(database, userId),
  ])
  if (metadata?.schemeVersion !== 2 || !latest || latest.keyId !== metadata.primaryKeyId) {
    return null
  }
  return latest
}

const shareEligibilityColumns = { id: user.id, email: user.email, isAnonymous: user.isAnonymous }

/** Users by normalized email, with what share eligibility needs. */
export const getUsersByEmails = async (database: QueryableDatabase, emails: string[]) =>
  database.select(shareEligibilityColumns).from(user).where(inArray(user.email, emails))

/** Users by id, with what share eligibility needs. */
export const getUsersByIds = async (database: QueryableDatabase, ids: string[]) =>
  database.select(shareEligibilityColumns).from(user).where(inArray(user.id, ids))

/**
 * Lock a live chat owned by `userId` for the rest of the transaction; false
 * when there is none. The lock is what keeps a share from being stored for a
 * chat whose delete is landing at the same moment: the delete's update waits
 * for this transaction, and its clean-up then removes what was stored.
 */
export const lockLiveOwnedThread = async (database: QueryableDatabase, userId: string, threadId: string) =>
  database
    .select({ id: chatThreadsTable.id })
    .from(chatThreadsTable)
    .where(
      and(eq(chatThreadsTable.id, threadId), eq(chatThreadsTable.userId, userId), isNull(chatThreadsTable.deletedAt)),
    )
    .for('update')
    .then((rows) => rows.length > 0)

/**
 * Take each recipient's key lock (`lockUserKeys`) so the current-version check
 * and the insert see the same inbox key. Sorted, so two shares locking
 * overlapping recipients cannot deadlock.
 */
export const lockRecipients = async (database: Pick<typeof DbType, 'execute'>, userIds: string[]) => {
  for (const userId of [...userIds].sort()) {
    await lockUserKeys(database, userId)
  }
}

/**
 * A share by id, whoever owns it, locked for this transaction; null when there
 * is none. Every write that changes who is on a share takes this lock first,
 * so "is anyone left on it?" is answered by one transaction at a time.
 */
export const lockShare = async (database: QueryableDatabase, shareId: string) =>
  database
    .select({
      id: chatSharesTable.id,
      ownerUserId: chatSharesTable.ownerUserId,
      chatThreadId: chatSharesTable.chatThreadId,
      version: chatSharesTable.version,
    })
    .from(chatSharesTable)
    .where(eq(chatSharesTable.id, shareId))
    .for('update')
    .then((rows) => rows[0] ?? null)

/** The id of the share of one chat, if it has one — a chat has at most one. */
export const getShareIdForThread = async (database: QueryableDatabase, ownerUserId: string, chatThreadId: string) =>
  database
    .select({ id: chatSharesTable.id })
    .from(chatSharesTable)
    .where(and(eq(chatSharesTable.ownerUserId, ownerUserId), eq(chatSharesTable.chatThreadId, chatThreadId)))
    .then((rows) => rows[0]?.id ?? null)

/**
 * Rebuild the synced `received_shares` and `sent_shares` rows of these shares
 * from the share tables, inside the transaction that changed who is on them.
 * Deleting a share needs no rebuild: both tables cascade on `chat_shares.id`.
 * Names and emails are copied as of the rebuild.
 */
export const rebuildShareRows = async (database: QueryableDatabase, shareIds: string[]) => {
  if (shareIds.length === 0) {
    return
  }
  await database.delete(receivedSharesTable).where(inArray(receivedSharesTable.id, shareIds))
  await database.delete(sentSharesTable).where(inArray(sentSharesTable.id, shareIds))
  const shares = await database
    .select({
      id: chatSharesTable.id,
      ownerUserId: chatSharesTable.ownerUserId,
      ownerName: user.name,
      ownerEmail: user.email,
      chatThreadId: chatSharesTable.chatThreadId,
      encryptedTitle: chatSharesTable.encryptedTitle,
      version: chatSharesTable.version,
      updatedAt: chatSharesTable.updatedAt,
    })
    .from(chatSharesTable)
    .innerJoin(chatThreadsTable, liveSourceThread)
    .innerJoin(user, eq(user.id, chatSharesTable.ownerUserId))
    .where(inArray(chatSharesTable.id, shareIds))
  if (shares.length === 0) {
    return
  }
  const recipients = await database
    .select({
      shareId: chatShareRecipientsTable.shareId,
      userId: user.id,
      name: user.name,
      email: user.email,
      inboxVersion: chatShareRecipientsTable.inboxVersion,
      sealedShareKey: chatShareRecipientsTable.sealedShareKey,
    })
    .from(chatShareRecipientsTable)
    .innerJoin(user, eq(user.id, chatShareRecipientsTable.recipientUserId))
    .where(
      inArray(
        chatShareRecipientsTable.shareId,
        shares.map((share) => share.id),
      ),
    )
    .orderBy(asc(chatShareRecipientsTable.createdAt), asc(chatShareRecipientsTable.recipientUserId))
  const recipientsOf = (shareId: string) => recipients.filter((recipient) => recipient.shareId === shareId)
  const received = shares.flatMap((share) =>
    recipientsOf(share.id).map((recipient) => ({
      id: share.id,
      userId: recipient.userId,
      ownerUserId: share.ownerUserId,
      ownerName: share.ownerName,
      ownerEmail: share.ownerEmail,
      encryptedTitle: share.encryptedTitle,
      sealedShareKey: recipient.sealedShareKey,
      inboxVersion: recipient.inboxVersion,
      updatedAt: share.updatedAt.toISOString(),
    })),
  )
  if (received.length > 0) {
    await database.insert(receivedSharesTable).values(received)
  }
  await database.insert(sentSharesTable).values(
    shares.map((share) => ({
      id: share.id,
      userId: share.ownerUserId,
      chatThreadId: share.chatThreadId,
      recipients: JSON.stringify(
        recipientsOf(share.id).map(({ userId, name, email }): ShareUser => ({ userId, name, email })),
      ),
      version: share.version,
      updatedAt: share.updatedAt.toISOString(),
    })),
  )
}

/**
 * Store a share, or replace one in place: the snapshot, the title and every
 * recipient's sealed key are swapped for the new ones, and anyone left off the
 * new list is removed. Returns the share's new version and the recipients it
 * already had, so the caller only emails the new ones; null when the id turned
 * out to be another chat's share, which a concurrent create of the same id can
 * only reveal here.
 */
export const putShare = async (
  database: QueryableDatabase,
  share: {
    id: string
    ownerUserId: string
    chatThreadId: string
    encryptedSnapshot: string
    encryptedTitle: string
    recipients: Array<{ recipientUserId: string; inboxVersion: number; sealedShareKey: string }>
  },
): Promise<{ version: number; previousRecipientIds: string[] } | null> => {
  const { recipients, ...row } = share
  const previous = await database
    .select({ recipientUserId: chatShareRecipientsTable.recipientUserId })
    .from(chatShareRecipientsTable)
    .where(eq(chatShareRecipientsTable.shareId, row.id))
  const written = await database
    .insert(chatSharesTable)
    .values(row)
    .onConflictDoUpdate({
      target: chatSharesTable.id,
      set: {
        encryptedSnapshot: row.encryptedSnapshot,
        encryptedTitle: row.encryptedTitle,
        updatedAt: sql`now()`,
        version: sql`${chatSharesTable.version} + 1`,
      },
      setWhere: and(
        eq(chatSharesTable.ownerUserId, row.ownerUserId),
        eq(chatSharesTable.chatThreadId, row.chatThreadId),
      ),
    })
    .returning()
  if (written.length === 0) {
    return null
  }
  await database.delete(chatShareRecipientsTable).where(
    and(
      eq(chatShareRecipientsTable.shareId, row.id),
      notInArray(
        chatShareRecipientsTable.recipientUserId,
        recipients.map((recipient) => recipient.recipientUserId),
      ),
    ),
  )
  await database
    .insert(chatShareRecipientsTable)
    .values(recipients.map((recipient) => ({ shareId: row.id, ...recipient })))
    .onConflictDoUpdate({
      target: [chatShareRecipientsTable.shareId, chatShareRecipientsTable.recipientUserId],
      set: { inboxVersion: sql`excluded.inbox_version`, sealedShareKey: sql`excluded.sealed_share_key` },
    })
  await rebuildShareRows(database, [row.id])
  return {
    version: written[0]!.version,
    previousRecipientIds: previous.map((recipient) => recipient.recipientUserId),
  }
}

/** One live share sent to `recipientUserId`, with its snapshot; null when it is not theirs or is gone. */
export const getReceivedShare = async (database: QueryableDatabase, recipientUserId: string, shareId: string) =>
  database
    .select({
      id: chatSharesTable.id,
      updatedAt: chatSharesTable.updatedAt,
      ownerUserId: user.id,
      ownerName: user.name,
      ownerEmail: user.email,
      encryptedTitle: chatSharesTable.encryptedTitle,
      sealedShareKey: chatShareRecipientsTable.sealedShareKey,
      inboxVersion: chatShareRecipientsTable.inboxVersion,
      encryptedSnapshot: chatSharesTable.encryptedSnapshot,
    })
    .from(chatShareRecipientsTable)
    .innerJoin(chatSharesTable, eq(chatSharesTable.id, chatShareRecipientsTable.shareId))
    .innerJoin(chatThreadsTable, liveSourceThread)
    .innerJoin(user, eq(user.id, chatSharesTable.ownerUserId))
    .where(and(eq(chatShareRecipientsTable.recipientUserId, recipientUserId), eq(chatSharesTable.id, shareId)))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Hard-delete one of the caller's shares (stop sharing). Run inside a transaction. Returns whether it was theirs. */
export const deleteShare = async (database: QueryableDatabase, ownerUserId: string, shareId: string) => {
  if ((await lockShare(database, shareId))?.ownerUserId !== ownerUserId) {
    return false
  }
  await database.delete(chatSharesTable).where(eq(chatSharesTable.id, shareId))
  return true
}

const hasNoRecipients = notExists(
  sql`(select 1 from ${chatShareRecipientsTable} where ${chatShareRecipientsTable.shareId} = ${chatSharesTable.id})`,
)

/**
 * Take one person off a share, and delete the share once nobody is left on it:
 * a share nobody can open is just ciphertext. Run inside a transaction. Returns
 * whether they were on it; when they were not, nothing is written.
 */
export const removeShareRecipient = async (database: QueryableDatabase, shareId: string, recipientUserId: string) => {
  await lockShare(database, shareId)
  const deleted = await database
    .delete(chatShareRecipientsTable)
    .where(
      and(eq(chatShareRecipientsTable.shareId, shareId), eq(chatShareRecipientsTable.recipientUserId, recipientUserId)),
    )
    .returning()
  if (deleted.length === 0) {
    return false
  }
  await database.delete(chatSharesTable).where(and(eq(chatSharesTable.id, shareId), hasNoRecipients))
  await rebuildShareRows(database, [shareId])
  return true
}

/**
 * Hard-delete every share whose only recipient is `recipientUserId` — run
 * before that account is deleted, whose cascade would otherwise leave those
 * shares behind with nobody on them. Locks every share they are on first, in
 * id order, so a concurrent removal of another recipient is answered one at a
 * time. Returns the ids of every share they were on, deleted or not, so the
 * caller can rebuild the ones that remain once the account is gone.
 */
export const deleteSharesWithSoleRecipient = async (
  database: QueryableDatabase,
  recipientUserId: string,
): Promise<string[]> => {
  const isOnShare = exists(
    sql`(select 1 from ${chatShareRecipientsTable} where ${chatShareRecipientsTable.shareId} = ${chatSharesTable.id} and ${chatShareRecipientsTable.recipientUserId} = ${recipientUserId})`,
  )
  const sharesOn = await database
    .select({ id: chatSharesTable.id })
    .from(chatSharesTable)
    .where(isOnShare)
    .orderBy(chatSharesTable.id)
    .for('update')
  await database
    .delete(chatSharesTable)
    .where(
      and(
        isOnShare,
        notExists(
          sql`(select 1 from ${chatShareRecipientsTable} where ${chatShareRecipientsTable.shareId} = ${chatSharesTable.id} and ${chatShareRecipientsTable.recipientUserId} <> ${recipientUserId})`,
        ),
      ),
    )
  return sharesOn.map((share) => share.id)
}

/** Hard-delete every share of one chat — the clean-up once the chat itself is deleted. */
export const deleteSharesForThread = async (database: QueryableDatabase, ownerUserId: string, chatThreadId: string) => {
  await database
    .delete(chatSharesTable)
    .where(and(eq(chatSharesTable.ownerUserId, ownerUserId), eq(chatSharesTable.chatThreadId, chatThreadId)))
  await database
    .delete(chatShareNotificationsTable)
    .where(
      and(
        eq(chatShareNotificationsTable.ownerUserId, ownerUserId),
        eq(chatShareNotificationsTable.chatThreadId, chatThreadId),
      ),
    )
}

/**
 * Of the people just added to an owner's share of a chat, the ones to email:
 * those not emailed about that chat in the last `windowHours`. Records the
 * email for them, so removing and re-adding someone, or stopping and sharing
 * again, does not mail them each time.
 */
export const claimShareNotifications = async (
  database: QueryableDatabase,
  input: { ownerUserId: string; chatThreadId: string; recipientUserIds: string[]; windowHours: number },
): Promise<string[]> => {
  if (input.recipientUserIds.length === 0) {
    return []
  }
  const claimed = await database
    .insert(chatShareNotificationsTable)
    .values(
      input.recipientUserIds.map((recipientUserId) => ({
        ownerUserId: input.ownerUserId,
        chatThreadId: input.chatThreadId,
        recipientUserId,
      })),
    )
    .onConflictDoUpdate({
      target: [
        chatShareNotificationsTable.ownerUserId,
        chatShareNotificationsTable.chatThreadId,
        chatShareNotificationsTable.recipientUserId,
      ],
      set: { notifiedAt: sql`now()` },
      setWhere: sql`${chatShareNotificationsTable.notifiedAt} < now() - make_interval(hours => ${input.windowHours})`,
    })
    .returning()
  return claimed.map((row) => row.recipientUserId)
}
