/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import {
  claimShareNotifications,
  deleteShare,
  getCurrentInboxKey,
  getReceivedShare,
  getShareIdForThread,
  getUsersByEmails,
  getUsersByIds,
  lockLiveOwnedThread,
  lockRecipients,
  lockShare,
  putShare,
  removeShareRecipient,
} from '@/dal'
import { resolveEmailLocale } from '@/emails/i18n'
import { getCallerDevice } from '@/lib/caller-device'
import { verifyChallengeSignature } from '@/lib/canary'
import { proofSchema } from '@/lib/challenge-proof-schema'
import { normalizeEmail } from '@/lib/email'
import { notifyBestEffort } from '@/lib/notify-best-effort'
import { shareNotifications, type ShareNotifications } from '@/lib/share-notifications'
import { safeErrorHandler } from '@/middleware/error-handling'
import {
  base64Length,
  maxShareEmailLength,
  maxShareRecipients,
  maxShareSnapshotBytes,
  maxShareTitleBytes,
  type ReceivedShareSummary,
  shareNotFoundCode,
  type ShareConflictCode,
  type ShareErrorCode,
  type ShareRecipientCheck,
  type StoreShareRequest,
  type StoreShareResponse,
} from '@shared/chat-shares'
import { sealedShareKeyLength } from '@shared/e2ee-types'
import { Elysia, t, type AnyElysia } from 'elysia'

type ShareRoutesOptions = {
  auth: Auth
  database: typeof DbType
  settings: Pick<Settings, 'appUrl'>
  /** User-keyed limiter for the email lookup, charged per email — the lookup is an account-existence oracle. */
  lookupRateLimit?: AnyElysia
  /** User-keyed limiter for storing a share, which emails every new recipient. */
  shareRateLimit?: AnyElysia
  notifications?: ShareNotifications
}

const sealedShareKeyBase64Length = base64Length(sealedShareKeyLength)

/** How long after emailing someone about a chat its owner can add them again without another email. */
const shareNotificationWindowHours = 24

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

const shareIdParams = t.Object({ shareId: t.String({ pattern: uuidPattern }) })

type StoreShareInput = StoreShareRequest & { shareId: string; ownerUserId: string; deviceId: string }

type StoreShareOutcome =
  | { status: 'stored'; isNew: boolean; version: number; recipientsToEmail: Array<{ id: string; email: string }> }
  | { status: 'forbidden' }
  | { status: 'chat-not-found' }
  | { status: 'conflict'; code: ShareConflictCode }

/**
 * Create a chat's share or replace it, in one transaction. The chat row is
 * locked so a delete landing now waits and then cleans up after it; each
 * recipient's inbox lock is held so the current-version check and the write
 * see the same key.
 */
const storeShare = async (database: typeof DbType, input: StoreShareInput): Promise<StoreShareOutcome> =>
  // Every refusal returns rather than throws, so the transaction commits and
  // the proof's nonce stays spent: nothing is written before `putShare`.
  database.transaction(async (tx): Promise<StoreShareOutcome> => {
    if (!(await verifyChallengeSignature(tx, input.ownerUserId, input.proof, 'share', input.deviceId))) {
      return { status: 'forbidden' }
    }
    if (!(await lockLiveOwnedThread(tx, input.ownerUserId, input.chatThreadId))) {
      return { status: 'chat-not-found' }
    }
    const existing = await lockShare(tx, input.shareId)
    if (existing && (existing.ownerUserId !== input.ownerUserId || existing.chatThreadId !== input.chatThreadId)) {
      return { status: 'conflict', code: 'SHARE_ID_TAKEN' }
    }
    // Replacing a share swaps its whole recipient list, so it must replace the
    // version the client read: one edited or stopped since would lose people.
    if (input.replacesVersion !== existing?.version) {
      return { status: 'conflict', code: 'SHARE_CHANGED' }
    }
    if (!existing && (await getShareIdForThread(tx, input.ownerUserId, input.chatThreadId))) {
      return { status: 'conflict', code: 'CHAT_ALREADY_SHARED' }
    }

    // Each recipient must still hold the inbox version the client sealed to.
    // One that moved on may be sealing to a seed a revoked device kept, and
    // one with no current key cannot receive shares at all; either way the
    // client looks them up again.
    const recipientIds = input.recipients.map((recipient) => recipient.userId)
    await lockRecipients(tx, recipientIds)
    const accounts = await getUsersByIds(tx, recipientIds)
    for (const recipient of input.recipients) {
      const account = accounts.find((candidate) => candidate.id === recipient.userId)
      const inboxKey = account && !account.isAnonymous && (await getCurrentInboxKey(tx, account.id))
      if (!inboxKey || inboxKey.version !== recipient.inboxVersion) {
        return { status: 'conflict', code: 'RECIPIENT_CHANGED' }
      }
    }

    const written = await putShare(tx, {
      id: input.shareId,
      ownerUserId: input.ownerUserId,
      chatThreadId: input.chatThreadId,
      encryptedSnapshot: input.encryptedSnapshot,
      encryptedTitle: input.encryptedTitle,
      recipients: input.recipients.map((recipient) => ({
        recipientUserId: recipient.userId,
        inboxVersion: recipient.inboxVersion,
        sealedShareKey: recipient.sealedShareKey,
      })),
    })
    if (!written) {
      return { status: 'conflict', code: 'SHARE_ID_TAKEN' }
    }
    const toEmail = await claimShareNotifications(tx, {
      ownerUserId: input.ownerUserId,
      chatThreadId: input.chatThreadId,
      recipientUserIds: recipientIds.filter((id) => !written.previousRecipientIds.includes(id)),
      windowHours: shareNotificationWindowHours,
    })
    return {
      status: 'stored',
      isNew: !existing,
      version: written.version,
      recipientsToEmail: accounts.filter((account) => toEmail.includes(account.id)),
    }
  })

type ReceivedShareRow = NonNullable<Awaited<ReturnType<typeof getReceivedShare>>>

const toReceivedShareSummary = (row: ReceivedShareRow): ReceivedShareSummary => ({
  id: row.id,
  updatedAt: row.updatedAt.toISOString(),
  owner: { userId: row.ownerUserId, name: row.ownerName, email: row.ownerEmail },
  encryptedTitle: row.encryptedTitle,
  sealedShareKey: row.sealedShareKey,
  inboxVersion: row.inboxVersion,
})

/**
 * Rate-limit cost of a recipient lookup: one point per email asked about, so a
 * batch of 20 spends what 20 single lookups would. The body has already passed
 * validation when the limiter runs.
 */
export const countLookupEmails = (body: unknown): number =>
  typeof body === 'object' && body !== null && 'emails' in body && Array.isArray(body.emails) ? body.emails.length : 1

/**
 * Who an email can be shared with: an existing, non-anonymous account other
 * than the caller's, whose newest inbox key is current. Every other case gets
 * the same `unavailable` answer. An `ok` carries the account id and public
 * keys sealing needs, but not the account's name.
 */
const checkRecipients = async (
  database: typeof DbType,
  callerUserId: string,
  emails: string[],
): Promise<ShareRecipientCheck[]> => {
  const normalized = emails.map((email) => normalizeEmail(email))
  const users = await getUsersByEmails(database, [...new Set(normalized)])
  return Promise.all(
    normalized.map(async (email): Promise<ShareRecipientCheck> => {
      const recipient = users.find((candidate) => candidate.email === email)
      if (!recipient || recipient.isAnonymous || recipient.id === callerUserId) {
        return { email, status: 'unavailable' }
      }
      const inboxKey = await getCurrentInboxKey(database, recipient.id)
      if (!inboxKey) {
        return { email, status: 'unavailable' }
      }
      return {
        email,
        status: 'ok',
        userId: recipient.id,
        inboxVersion: inboxKey.version,
        ecdhPublicKey: inboxKey.ecdhPublicKey,
        mlkemPublicKey: inboxKey.mlkemPublicKey,
      }
    }),
  )
}

/**
 * Shared chats: view-only snapshots of one chat, as of its last share or update, sent to specific people.
 * The server holds each snapshot as ciphertext under a share key it never sees,
 * plus that key sealed to each recipient's inbox key. Every route needs a
 * trusted device bound to the session. Storing a share also needs a `share`
 * challenge proof: sealing takes only public keys, so without it a stolen
 * session could send content of its own in the account's name.
 */
export const createShareRoutes = ({
  auth,
  database,
  settings,
  lookupRateLimit,
  shareRateLimit,
  notifications = shareNotifications,
}: ShareRoutesOptions) =>
  new Elysia({ prefix: '/shares' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (guarded) =>
      guarded
        .resolve(async ({ request, session, user }) => ({
          caller: await getCallerDevice(database, user.id, request, session),
        }))
        .onBeforeHandle(({ caller, set, user }) => {
          // Anonymous accounts cannot sync chats, so they have nothing to share.
          if (user.isAnonymous) {
            set.status = 403
            return { error: 'Forbidden', code: 'ANONYMOUS_SHARE_FORBIDDEN' }
          }
          if ('error' in caller) {
            set.status = caller.status
            return { error: caller.error }
          }
          if (!caller.device.trusted) {
            set.status = 403
            return { error: 'Only trusted devices can share chats' }
          }
        })
        .get(
          '/:shareId',
          async ({ params, set, user }) => {
            const share = await getReceivedShare(database, user.id, params.shareId)
            if (!share) {
              set.status = 404
              return { error: 'Share not found', code: shareNotFoundCode }
            }
            return { ...toReceivedShareSummary(share), encryptedSnapshot: share.encryptedSnapshot }
          },
          { params: shareIdParams },
        )
        .delete(
          '/:shareId',
          async ({ params, set, user }) => {
            const deleted = await database.transaction((tx) => deleteShare(tx, user.id, params.shareId))
            if (!deleted) {
              set.status = 404
              return { error: 'Share not found', code: shareNotFoundCode }
            }
            set.status = 204
          },
          { params: shareIdParams },
        )
        .delete(
          '/:shareId/recipients/:recipientUserId',
          async ({ params, set, user }) => {
            const removed = await database.transaction(async (tx) => {
              if ((await lockShare(tx, params.shareId))?.ownerUserId !== user.id) {
                return false
              }
              return removeShareRecipient(tx, params.shareId, params.recipientUserId)
            })
            if (!removed) {
              set.status = 404
              return { error: 'Recipient not found', code: shareNotFoundCode }
            }
            set.status = 204
          },
          {
            params: t.Object({
              shareId: t.String({ pattern: uuidPattern }),
              recipientUserId: t.String({ maxLength: 64 }),
            }),
          },
        )
        // A recipient removing a chat shared with them: their copy goes, and
        // the share with it once nobody is left on it.
        .delete(
          '/received/:shareId',
          async ({ params, set, user }) => {
            const removed = await database.transaction((tx) => removeShareRecipient(tx, params.shareId, user.id))
            if (!removed) {
              set.status = 404
              return { error: 'Share not found', code: shareNotFoundCode }
            }
            set.status = 204
          },
          { params: shareIdParams },
        )
        .guard({}, (limited) => {
          if (lookupRateLimit) {
            limited.use(lookupRateLimit)
          }
          return limited.post(
            '/recipients/check',
            async ({ body, user }) => ({ recipients: await checkRecipients(database, user.id, body.emails) }),
            {
              body: t.Object({
                emails: t.Array(t.String({ minLength: 3, maxLength: maxShareEmailLength }), {
                  minItems: 1,
                  maxItems: maxShareRecipients,
                }),
              }),
            },
          )
        })
        .guard({}, (limited) => {
          if (shareRateLimit) {
            limited.use(shareRateLimit)
          }
          // Create a chat's share, or replace it. A chat has one share: storing
          // it again swaps the snapshot, the key and the recipient list in
          // place, keeping the id so earlier links keep working.
          return limited.post(
            '/:shareId',
            async ({ body, caller, params, request, set, user }) => {
              // Already refused by the device gate; this narrows the type.
              if ('error' in caller) {
                set.status = caller.status
                return { error: caller.error }
              }
              const recipientIds = body.recipients.map((recipient) => recipient.userId)
              if (new Set(recipientIds).size !== recipientIds.length || recipientIds.includes(user.id)) {
                set.status = 400
                return { error: 'Recipients must be distinct people other than you' }
              }

              const outcome = await storeShare(database, {
                ...body,
                shareId: params.shareId,
                ownerUserId: user.id,
                deviceId: caller.deviceId,
              })
              if (outcome.status === 'forbidden') {
                set.status = 403
                return { error: 'Invalid challenge proof' }
              }
              if (outcome.status === 'chat-not-found') {
                set.status = 404
                return { error: 'Chat not found', code: 'CHAT_NOT_FOUND' satisfies ShareErrorCode }
              }
              if (outcome.status === 'conflict') {
                set.status = 409
                return { error: 'Share conflict', code: outcome.code }
              }

              const locale = resolveEmailLocale(request.headers.get('X-App-Language'))
              const shareUrl = new URL(`/shared/${params.shareId}`, settings.appUrl).toString()
              for (const account of outcome.recipientsToEmail) {
                notifyBestEffort(
                  'chat-shared',
                  notifications.sendChatShared({
                    to: account.email,
                    sharerName: user.name || user.email,
                    sharerEmail: user.email,
                    shareUrl,
                    locale,
                  }),
                )
              }

              set.status = outcome.isNew ? 201 : 200
              return { id: params.shareId, version: outcome.version } satisfies StoreShareResponse
            },
            {
              params: shareIdParams,
              body: t.Object({
                chatThreadId: t.String({ minLength: 1, maxLength: 64 }),
                encryptedSnapshot: t.String({ minLength: 1, maxLength: base64Length(maxShareSnapshotBytes) }),
                encryptedTitle: t.String({ minLength: 1, maxLength: base64Length(maxShareTitleBytes) }),
                recipients: t.Array(
                  t.Object({
                    userId: t.String({ minLength: 1, maxLength: 64 }),
                    inboxVersion: t.Integer({ minimum: 1 }),
                    sealedShareKey: t.String({
                      minLength: sealedShareKeyBase64Length,
                      maxLength: sealedShareKeyBase64Length,
                    }),
                  }),
                  { minItems: 1, maxItems: maxShareRecipients },
                ),
                replacesVersion: t.Optional(t.Integer({ minimum: 1 })),
                proof: proofSchema,
              }),
            },
          )
        }),
    )
