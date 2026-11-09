/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { receivedSharesTable, sentSharesTable } from '@/db/tables'
import type { ReceivedShare } from '@/services/shares'
import type { ReceivedShareSummary } from '@shared/chat-shares'

/** A chat this account shared, as its synced row lists it. */
export type SentShare = Omit<typeof sentSharesTable.$inferSelect, 'userId'>

/** A synced `sent_shares` row, without the owner column every row of this account shares. */
export const toSentShare = ({ userId: _, ...share }: typeof sentSharesTable.$inferSelect): SentShare => share

/** A synced `received_shares` row in the shape the open path uses. */
export const toReceivedShareSummary = (row: typeof receivedSharesTable.$inferSelect): ReceivedShareSummary => ({
  id: row.id,
  updatedAt: row.updatedAt,
  owner: { userId: row.ownerUserId, name: row.ownerName, email: row.ownerEmail },
  encryptedTitle: row.encryptedTitle,
  sealedShareKey: row.sealedShareKey,
  inboxVersion: row.inboxVersion,
})

/** What a received share's decrypted title depends on: replacing it changes `updatedAt`. */
export const titleCacheKey = (share: ReceivedShareSummary) => `${share.id}:${share.updatedAt}:${share.inboxVersion}`

/**
 * The synced received shares with their titles. Without titles (they could not
 * be loaded), every title is `undefined`. When `isStale` (the titles are a
 * previous list's, and this one's are still decrypting), a share they do not
 * cover is left out until its title arrives, rather than shown as unreadable.
 */
export const withTitles = (
  shares: ReceivedShareSummary[],
  titles: Map<string, string | null> | undefined,
  isStale: boolean,
): ReceivedShare[] =>
  shares
    .filter((share) => !isStale || !titles || titles.has(share.id))
    .map((share) => ({ ...share, title: titles?.get(share.id) }))
