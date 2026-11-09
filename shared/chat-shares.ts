/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChallengeProof } from './e2ee-types'

/**
 * Wire contract for shared chats (`/v1/shares`). A share is a frozen, view-only
 * snapshot of one chat, encrypted once under a random share key; the server
 * stores the ciphertext and one sealed copy of the key per recipient, and can
 * open neither. A chat has at most one share, replaced in place when it is
 * shared again. See `docs/internals/architecture/chat-sharing.md`.
 */

/** Most people one share can go to. */
export const maxShareRecipients = 20

/** Longest email address a lookup accepts (RFC 5321's path limit). */
export const maxShareEmailLength = 254

/**
 * Largest snapshot ciphertext, in bytes. The whole create request must fit the
 * 1 MiB request-body default of the nginx paths in `deploy/`, and the snapshot
 * travels base64-encoded beside up to `maxShareRecipients` sealed keys.
 */
export const maxShareSnapshotBytes = 700 * 1024

/** Largest title ciphertext, in bytes. */
export const maxShareTitleBytes = 4 * 1024

/**
 * Largest snapshot JSON a recipient will decompress, in bytes. The ciphertext
 * cap bounds what is stored, not what it inflates to: gzip of repetitive input
 * expands about a thousandfold, so without this a sender could crash every
 * recipient's app on open. Real chats compress a few times over at most.
 */
export const maxShareSnapshotJsonBytes = 16 * 1024 * 1024

/** Base64 length of `byteLength` bytes. */
export const base64Length = (byteLength: number): number => Math.ceil(byteLength / 3) * 4

/** One recipient of `POST /shares/recipients/check`: shareable with its current inbox key, or not. */
export type ShareRecipientCheck =
  | {
      email: string
      status: 'ok'
      userId: string
      inboxVersion: number
      ecdhPublicKey: string
      mlkemPublicKey: string
    }
  /** No account, no current inbox key, an anonymous account, or yourself — deliberately indistinguishable. */
  | { email: string; status: 'unavailable' }

export type ShareRecipientCheckResponse = { recipients: ShareRecipientCheck[] }

/**
 * `POST /shares/:shareId` — create a chat's share, or replace it in place. The id
 * is client-generated for a new share, because the AADs bind it before the
 * request is sent; a replacement reuses the existing id. Carries a `share`
 * challenge proof.
 */
export type StoreShareRequest = {
  chatThreadId: string
  /** base64 `iv ‖ AES-GCM(gzip(snapshot JSON))`, AAD `shareSnapshotAAD`. */
  encryptedSnapshot: string
  /** base64 `iv ‖ AES-GCM(title)`, AAD `shareTitleAAD`. */
  encryptedTitle: string
  recipients: Array<{ userId: string; inboxVersion: number; sealedShareKey: string }>
  /**
   * The `version` of the share this write replaces, as the client read it.
   * Absent for a new share. A share edited or stopped since is refused, since
   * the write would otherwise drop people added in between.
   */
  replacesVersion?: number
  proof: ChallengeProof
}

/** `POST /shares/:shareId` succeeded: the share's id and its new version. */
export type StoreShareResponse = { id: string; version: number }

/**
 * Why a share write was refused with 409. `RECIPIENT_CHANGED`: a recipient's
 * inbox key moved on or went away since the lookup — look them up again.
 * `CHAT_ALREADY_SHARED`: the chat has a share under another id — reload it.
 * `SHARE_CHANGED`: the share was edited or stopped since `replacesVersion`
 * was read — reload it. `SHARE_ID_TAKEN`: the id belongs to another chat.
 */
export type ShareConflictCode = 'RECIPIENT_CHANGED' | 'CHAT_ALREADY_SHARED' | 'SHARE_CHANGED' | 'SHARE_ID_TAKEN'

/**
 * The `code` on a 404 for a share that no longer exists, or a person no longer
 * on it — told apart from the device gate's 404, which carries none.
 */
export const shareNotFoundCode = 'SHARE_NOT_FOUND'

/** Every `code` a share write's error response carries: the 409s, and a 404 for a chat not synced yet. */
export type ShareErrorCode = ShareConflictCode | 'CHAT_NOT_FOUND'

export type ShareUser = { userId: string; name: string; email: string }

/**
 * The caller's copy of a share's key and title, enough to list it without the
 * snapshot. Devices list these from the synced `received_shares` table.
 */
export type ReceivedShareSummary = {
  id: string
  /** When the snapshot was last replaced — the time to show as "shared". */
  updatedAt: string
  owner: ShareUser
  encryptedTitle: string
  sealedShareKey: string
  inboxVersion: number
}

/** GET /shares/:id — one received share with its snapshot. */
export type ReceivedShareResponse = ReceivedShareSummary & { encryptedSnapshot: string }
