/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { checkShareRecipients, fetchReceivedShare, storeShare } from '@/api/shares'
import { type HttpClient } from '@/contexts'
import {
  base64ByteLength,
  decryptShareJson,
  decryptShareText,
  encryptShareJson,
  encryptShareText,
  generateShareKey,
  openShareKey,
  sealShareKey,
  type ShareKey,
} from '@/crypto/share-seal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getChatMessages } from '@/dal/chat-messages'
import { getChatThread } from '@/dal/chat-threads'
import { HttpError } from '@/lib/http'
import { DecryptionError } from '@/crypto/errors'
import { getCachedSession } from '@/lib/session-cache'
import { buildShareSnapshot, parseShareSnapshot, type ShareSnapshot } from '@/shared-chats/snapshot'
import { waitForSentShareVersion } from '@/shared-chats/synced-share-rows'
import {
  maxShareSnapshotBytes,
  maxShareTitleBytes,
  type ReceivedShareResponse,
  type ReceivedShareSummary,
  type ShareRecipientCheck,
  type ShareErrorCode,
  shareNotFoundCode,
  type StoreShareRequest,
} from '@shared/chat-shares'
import { shareSnapshotAAD, shareTitleAAD } from '@shared/e2ee-types'
import { ZodError } from 'zod'
import { buildShareProof, openInboxKeys, type OpenedInboxKey } from './encryption'

/** A recipient the directory said can receive shares. */
export type ShareableRecipient = Extract<ShareRecipientCheck, { status: 'ok' }>

/** The chat is too large to share — almost always an artifact carrying embedded images. */
export class ShareTooLargeError extends Error {
  constructor() {
    super('This chat is too large to share')
    this.name = 'ShareTooLargeError'
  }
}

/**
 * The chat's share was created, edited or stopped on another device since this
 * dialog loaded; reload it and try again.
 */
export class ShareChangedElsewhereError extends Error {
  constructor() {
    super('This chat’s share changed on another device')
    this.name = 'ShareChangedElsewhereError'
  }
}

/** The server has no live copy of the chat yet: it was created offline and has not synced. */
export class ChatNotSyncedError extends Error {
  constructor() {
    super('This chat has not finished syncing')
    this.name = 'ChatNotSyncedError'
  }
}

/** A recipient can no longer receive shares — their inbox key went stale and has not been replaced. */
export class RecipientUnavailableError extends Error {
  constructor(readonly email: string) {
    super(`${email} can no longer receive shared chats`)
    this.name = 'RecipientUnavailableError'
  }
}

const getUserId = (): string => {
  const userId = getCachedSession()?.user?.id
  if (!userId) {
    throw new Error('User id not available — cannot bind share AAD')
  }
  return userId
}

/** Look emails up in the directory. */
export const lookUpRecipients = async (httpClient: HttpClient, emails: string[]): Promise<ShareRecipientCheck[]> =>
  (await checkShareRecipients(httpClient, emails)).recipients

const sealForRecipients = (
  shareKey: ShareKey,
  shareId: string,
  ownerUserId: string,
  recipients: ShareableRecipient[],
) =>
  Promise.all(
    recipients.map(async (recipient) => ({
      userId: recipient.userId,
      inboxVersion: recipient.inboxVersion,
      sealedShareKey: await sealShareKey(shareKey, recipient, {
        shareId,
        ownerUserId,
        recipientUserId: recipient.userId,
        inboxVersion: recipient.inboxVersion,
      }),
    })),
  )

/** Refresh recipients whose inbox key may have moved on; any that can no longer receive shares fail the share. */
const relookUp = async (httpClient: HttpClient, recipients: ShareableRecipient[]): Promise<ShareableRecipient[]> => {
  const fresh = await lookUpRecipients(
    httpClient,
    recipients.map((recipient) => recipient.email),
  )
  return fresh.map((recipient) => {
    if (recipient.status !== 'ok') {
      throw new RecipientUnavailableError(recipient.email)
    }
    return recipient
  })
}

/** The `code` an error response carries, unchecked; undefined for any other failure. */
const responseCode = async (err: unknown): Promise<unknown> => {
  if (!(err instanceof HttpError)) {
    return undefined
  }
  try {
    const body: { code?: unknown } = await err.response.clone().json()
    return body.code
  } catch {
    return undefined
  }
}

/** The error the dialog explains for each refusal it can act on; `RECIPIENT_CHANGED` is retried instead. */
const shareErrorFor: Record<Exclude<ShareErrorCode, 'RECIPIENT_CHANGED'>, () => Error> = {
  CHAT_NOT_FOUND: () => new ChatNotSyncedError(),
  CHAT_ALREADY_SHARED: () => new ShareChangedElsewhereError(),
  SHARE_CHANGED: () => new ShareChangedElsewhereError(),
  SHARE_ID_TAKEN: () => new ShareChangedElsewhereError(),
}

const isExplainedRefusal = (code: unknown): code is keyof typeof shareErrorFor =>
  typeof code === 'string' && Object.hasOwn(shareErrorFor, code)

/**
 * Return when a refused share write means a recipient must be looked up again;
 * otherwise throw the error the dialog explains, or the original one when it
 * is not a share refusal at all.
 */
export const assertRecipientChanged = async (err: unknown): Promise<void> => {
  const code = await responseCode(err)
  if (code === 'RECIPIENT_CHANGED') {
    return
  }
  throw isExplainedRefusal(code) ? shareErrorFor[code]() : err
}

/**
 * Store a share, redoing it once if a recipient's inbox key moved on in
 * between. `store` seals to the recipients it is given and sends; `lookUpAgain`
 * fetches their current keys, failing for one who can no longer receive shares.
 */
export const storeWithReseal = async <T>(
  store: (recipients: ShareableRecipient[]) => Promise<T>,
  lookUpAgain: (recipients: ShareableRecipient[]) => Promise<ShareableRecipient[]>,
  recipients: ShareableRecipient[],
): Promise<T> => {
  try {
    return await store(recipients)
  } catch (err) {
    await assertRecipientChanged(err)
    const fresh = await lookUpAgain(recipients)
    try {
      return await store(fresh)
    } catch (retryErr) {
      await assertRecipientChanged(retryErr)
      // A second change while resealing is not worth a third try.
      throw new Error('A recipient’s inbox key changed again while sharing', { cause: retryErr })
    }
  }
}

/** Encrypt the snapshot and title under a new share key and seal it to each recipient — one share write's body. */
const sealShare = async (
  httpClient: HttpClient,
  input: { shareId: string; ownerUserId: string; chatThreadId: string; title: string; snapshot: ShareSnapshot },
  recipients: ShareableRecipient[],
  replacesVersion: number | undefined,
): Promise<StoreShareRequest> => {
  const shareKey = await generateShareKey()
  try {
    const encryptedSnapshot = await encryptShareJson(
      input.snapshot,
      shareKey.key,
      shareSnapshotAAD(input.shareId, input.ownerUserId),
    )
    const encryptedTitle = await encryptShareText(
      input.title,
      shareKey.key,
      shareTitleAAD(input.shareId, input.ownerUserId),
    )
    if (
      base64ByteLength(encryptedSnapshot) > maxShareSnapshotBytes ||
      base64ByteLength(encryptedTitle) > maxShareTitleBytes
    ) {
      throw new ShareTooLargeError()
    }
    return {
      chatThreadId: input.chatThreadId,
      encryptedSnapshot,
      encryptedTitle,
      recipients: await sealForRecipients(shareKey, input.shareId, input.ownerUserId, recipients),
      replacesVersion,
      proof: await buildShareProof(httpClient),
    }
  } finally {
    shareKey.raw.fill(0)
  }
}

/**
 * Share a chat, as it stands now, with people the directory approved — or
 * replace its existing share (`existing`, at the version the caller read) with
 * a fresh snapshot for the given people. Either way the chat is snapshotted,
 * encrypted under a new share key, and that key sealed to each recipient's
 * inbox key; the server receives only ciphertext. Resolves with the share id
 * once this device's synced list shows the write (or the best-effort wait for
 * it gives up), so a dialog opened next starts from it.
 *
 * A `RECIPIENT_CHANGED` conflict means a recipient's inbox key moved on or went
 * away between the lookup and the share (a device of theirs was revoked). The
 * key the refused seal targets may be held by that revoked device, so the
 * recipients are looked up again and the whole write is redone under another
 * new key; one that can no longer receive shares fails the share with
 * `RecipientUnavailableError`.
 */
export const shareChat = async (
  httpClient: HttpClient,
  db: AnyDrizzleDatabase,
  chatThreadId: string,
  recipients: ShareableRecipient[],
  existing?: { shareId: string; version: number },
): Promise<string> => {
  const thread = await getChatThread(db, chatThreadId)
  if (!thread) {
    throw new Error('Chat not found')
  }
  const title = thread.title ?? ''
  const input = {
    shareId: existing?.shareId ?? crypto.randomUUID(),
    ownerUserId: getUserId(),
    chatThreadId,
    title,
    snapshot: buildShareSnapshot(title, await getChatMessages(db, chatThreadId)),
  }
  const { version } = await storeWithReseal(
    async (to) => storeShare(httpClient, input.shareId, await sealShare(httpClient, input, to, existing?.version)),
    (fresh) => relookUp(httpClient, fresh),
    recipients,
  )
  await waitForSentShareVersion(input.shareId, version)
  return input.shareId
}

/** Open the share key sealed to this account, or null when this device cannot. */
const openSealedShareKey = async (
  share: ReceivedShareSummary,
  inboxKey: OpenedInboxKey | undefined,
  recipientUserId: string,
): Promise<CryptoKey | null> => {
  if (!inboxKey) {
    return null
  }
  try {
    return await openShareKey(share.sealedShareKey, inboxKey.keyPair, inboxKey, {
      shareId: share.id,
      ownerUserId: share.owner.userId,
      recipientUserId,
      inboxVersion: share.inboxVersion,
    })
  } catch (err) {
    // A seal that does not open is a share this account cannot read — shown as
    // such, never as content.
    if (err instanceof DecryptionError) {
      return null
    }
    throw err
  }
}

const decryptTitle = async (share: ReceivedShareSummary, key: CryptoKey): Promise<string | null> => {
  try {
    return await decryptShareText(share.encryptedTitle, key, shareTitleAAD(share.id, share.owner.userId))
  } catch (err) {
    if (err instanceof DecryptionError) {
      return null
    }
    throw err
  }
}

/**
 * A received share with its title: opened, `null` when this device cannot open
 * it, or `undefined` when it could not be opened right now (offline, or the
 * inbox keys failed to load).
 */
export type ReceivedShare = ReceivedShareSummary & { title: string | null | undefined }

/** Decrypt the titles of shares sent to this account, by share id; `null` for one this device cannot open. */
export const decryptReceivedTitles = async (
  httpClient: HttpClient,
  shares: ReceivedShareSummary[],
): Promise<Map<string, string | null>> => {
  if (shares.length === 0) {
    return new Map()
  }
  const recipientUserId = getUserId()
  const inboxKeys = await openInboxKeys(httpClient, [...new Set(shares.map((share) => share.inboxVersion))])
  const titles = await Promise.all(
    shares.map(async (share) => {
      const key = await openSealedShareKey(share, inboxKeys.get(share.inboxVersion), recipientUserId)
      return [share.id, key ? await decryptTitle(share, key) : null] as const
    }),
  )
  return new Map(titles)
}

/** The share's key is sealed to a key this device does not hold. */
export class ShareUnreadableError extends Error {
  constructor(options?: ErrorOptions) {
    super('This shared chat cannot be opened on this device', options)
    this.name = 'ShareUnreadableError'
  }
}

/**
 * The share's key opened, but its content did not decrypt, decompress or parse
 * — a snapshot from a newer client, or a damaged one. No other device would
 * do better.
 */
export class ShareContentInvalidError extends Error {
  constructor(options?: ErrorOptions) {
    super('This shared chat’s content cannot be displayed', options)
    this.name = 'ShareContentInvalidError'
  }
}

/** The share no longer exists, or no longer lists this account. */
export class ShareGoneError extends Error {
  constructor(options?: ErrorOptions) {
    super('This chat is no longer shared with you', options)
    this.name = 'ShareGoneError'
  }
}

/** Whether a request failed because the share, or the person on it, is already gone. */
export const isShareGone = async (err: unknown): Promise<boolean> =>
  err instanceof HttpError && err.response.status === 404 && (await responseCode(err)) === shareNotFoundCode

const fetchStillShared = async (httpClient: HttpClient, shareId: string): Promise<ReceivedShareResponse> => {
  try {
    return await fetchReceivedShare(httpClient, shareId)
  } catch (err) {
    if (await isShareGone(err)) {
      throw new ShareGoneError({ cause: err })
    }
    throw err
  }
}

/** One received share, opened: its metadata and the snapshot to render. */
export type OpenedShare = { share: ReceivedShareResponse; snapshot: ShareSnapshot }

/**
 * Fetch and open one share sent to this account. A share that is gone throws
 * `ShareGoneError`; a seal for a key this device lacks, `ShareUnreadableError`;
 * content that fails to decrypt, decompress or parse, `ShareContentInvalidError`.
 * Anything else (network, server) is rethrown as itself.
 */
export const openReceivedShare = async (httpClient: HttpClient, shareId: string): Promise<OpenedShare> => {
  const share = await fetchStillShared(httpClient, shareId)
  const recipientUserId = getUserId()
  const inboxKeys = await openInboxKeys(httpClient, [share.inboxVersion])
  const key = await openSealedShareKey(share, inboxKeys.get(share.inboxVersion), recipientUserId)
  if (!key) {
    throw new ShareUnreadableError()
  }
  try {
    const decrypted = await decryptShareJson(
      share.encryptedSnapshot,
      key,
      shareSnapshotAAD(share.id, share.owner.userId),
    )
    return { share, snapshot: parseShareSnapshot(decrypted) }
  } catch (err) {
    if (err instanceof DecryptionError || err instanceof ZodError) {
      throw new ShareContentInvalidError({ cause: err })
    }
    throw err
  }
}
