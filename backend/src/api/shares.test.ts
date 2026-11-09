/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { encryptionMetadataTable, inboxKeysTable } from '@/db/encryption-schema'
import {
  chatShareNotificationsTable,
  chatShareRecipientsTable,
  chatSharesTable,
  chatThreadsTable,
  devicesTable,
  receivedSharesTable,
  sentSharesTable,
} from '@/db/schema'
import { deleteUser, issueChallengeNonce } from '@/dal'
import { applyOperation } from '@/dal/powersync'
import type { ShareNotifications } from '@/lib/share-notifications'
import { createTestDb } from '@/test-utils/db'
import { exportSigningPublicKey, generateSigningKeypair, signChallenge } from '@/test-utils/e2ee'
import { createRejectingRateLimit } from '@/test-utils/rate-limit'
import { base64Length } from '@shared/chat-shares'
import { sealedShareKeyLength } from '@shared/e2ee-types'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHmac } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Elysia, type AnyElysia } from 'elysia'
import { countLookupEmails, createShareRoutes } from './shares'

const baseUrl = 'http://localhost'
const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const signToken = (token: string): string =>
  `${token}.${createHmac('sha256', betterAuthSecret).update(token).digest('base64')}`

const sealedShareKey = 'K'.repeat(base64Length(sealedShareKeyLength))
const shareId = '2f6c1a0e-5d1b-4c39-9f7e-1a2b3c4d5e6f'
const otherShareId = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('Shares API', () => {
  let app: { handle: (request: Request) => Promise<Response> }
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let sentEmails: Array<Parameters<ShareNotifications['sendChatShared']>[0]>
  /** Accounts this test created. The routes commit their own transactions, so cleanup deletes them explicitly. */
  let createdAccounts: string[]
  /** Each account's challenge signing key, the one its proofs are verified against. */
  let signingKeys: Map<string, CryptoKeyPair>

  const now = new Date()

  const mountApp = (limits: { lookupRateLimit?: AnyElysia; shareRateLimit?: AnyElysia } = {}) => {
    app = new Elysia().use(
      createShareRoutes({
        auth: createAuth(db),
        database: db,
        settings: { appUrl: 'https://app.test' },
        ...limits,
        notifications: {
          sendChatShared: async (params) => {
            sentEmails.push(params)
          },
        },
      }),
    )
  }

  /** A user with a session bound to a device, and the bearer token that session answers to. */
  const createAccount = async (
    id: string,
    options: { trusted?: boolean; inbox?: 'current' | 'stale' | 'none'; anonymous?: boolean } = {},
  ) => {
    const { trusted = true, inbox = 'current', anonymous = false } = options
    createdAccounts.push(id)
    const keypair = await generateSigningKeypair()
    signingKeys.set(id, keypair)
    await db.insert(userTable).values({
      id,
      name: `Name ${id}`,
      email: `${id}@test.com`,
      emailVerified: true,
      isAnonymous: anonymous,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(devicesTable).values({
      id: `device-${id}`,
      userId: id,
      name: 'Test Device',
      trusted,
      approvalPending: !trusted,
      publicKey: 'pk',
      mlkemPublicKey: 'mlkem',
      lastSeen: now,
      createdAt: now,
    })
    await db.insert(sessionTable).values({
      id: `session-${id}`,
      token: `token-${id}`,
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
      userId: id,
      deviceId: `device-${id}`,
    })
    await db.insert(encryptionMetadataTable).values({
      userId: id,
      canaryIv: 'iv',
      canaryCtext: 'ctext',
      signingPublicKey: await exportSigningPublicKey(keypair),
      kdfSalt: 'salt',
      keyVersion: 1,
      primaryKeyId: inbox === 'stale' ? '1' : '0',
      schemeVersion: 2,
      createdAt: now,
    })
    if (inbox !== 'none') {
      await db.insert(inboxKeysTable).values({
        userId: id,
        version: 1,
        keyId: '0',
        ecdhPublicKey: `ecdh-${id}`,
        mlkemPublicKey: `mlkem-${id}`,
        encryptedSeed: 'seed',
      })
    }
  }

  const createThread = async (userId: string, id = 'thread-1') =>
    db.insert(chatThreadsTable).values({ id, userId, title: '__enc:v2:0:iv:ct' })

  /** A `share` proof from `accountId`'s device, signed with `keypair` (its own by default). */
  const shareProof = async (accountId: string, keypair = signingKeys.get(accountId)!) => {
    const deviceId = `device-${accountId}`
    const { nonce } = await issueChallengeNonce(db, {
      userId: accountId,
      operation: 'share',
      deviceId,
      ttlMs: 60_000,
    })
    return {
      signature: await signChallenge(keypair.privateKey, nonce, 'share', deviceId),
      nonce,
      operation: 'share',
      deviceId,
    }
  }

  const request = (accountId: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    app.handle(
      new Request(`${baseUrl}/shares${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signToken(`token-${accountId}`)}`,
          'X-Device-ID': `device-${accountId}`,
          'X-App-Language': 'de',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    )

  const recipient = (userId: string, inboxVersion = 1) => ({ userId, inboxVersion, sealedShareKey })

  /** Store a share as `accountId`, with a fresh valid proof unless the body brings its own. */
  const putShare = async (
    accountId: string,
    overrides: Record<string, unknown> = {},
    id = shareId,
  ): Promise<Response> =>
    request(accountId, `/${id}`, {
      method: 'POST',
      body: {
        chatThreadId: 'thread-1',
        encryptedSnapshot: 'snapshot-ciphertext',
        encryptedTitle: 'title-ciphertext',
        recipients: [recipient('bob')],
        proof: await shareProof(accountId),
        ...overrides,
      },
    })

  /** The synced rows listing what `accountId` shared. */
  const sentRows = (accountId: string) => db.select().from(sentSharesTable).where(eq(sentSharesTable.userId, accountId))

  /** The synced rows listing what was shared with `accountId`. */
  const receivedRows = (accountId: string) =>
    db.select().from(receivedSharesTable).where(eq(receivedSharesTable.userId, accountId))

  /** The version of Alice's share a replace must name, as her synced sent list shows it. */
  const shareVersion = async (): Promise<number> => (await sentRows('alice'))[0]!.version

  /** Alice shares thread-1 with Bob. */
  const shareWithBob = async () => {
    await createAccount('alice')
    await createAccount('bob')
    await createThread('alice')
    expect((await putShare('alice')).status).toBe(201)
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    sentEmails = []
    createdAccounts = []
    signingKeys = new Map()
    mountApp()
  })

  afterEach(async () => {
    // Deleting the accounts cascades to their sessions, devices, chats, keys and shares.
    if (createdAccounts.length > 0) {
      await db.delete(userTable).where(inArray(userTable.id, createdAccounts))
    }
    await cleanup()
  })

  describe('POST /shares/recipients/check', () => {
    it('returns the current inbox key of an eligible recipient, matching the email case-insensitively', async () => {
      await createAccount('alice')
      await createAccount('bob')

      const response = await request('alice', '/recipients/check', {
        method: 'POST',
        body: { emails: [' BOB@test.com '] },
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        recipients: [
          {
            email: 'bob@test.com',
            status: 'ok',
            userId: 'bob',
            inboxVersion: 1,
            ecdhPublicKey: 'ecdh-bob',
            mlkemPublicKey: 'mlkem-bob',
          },
        ],
      })
    })

    it('answers every ineligible case with the same two fields', async () => {
      await createAccount('alice')
      await createAccount('noinbox', { inbox: 'none' })
      await createAccount('stale', { inbox: 'stale' })
      await createAccount('anon', { anonymous: true })
      const emails = ['nobody@test.com', 'alice@test.com', 'noinbox@test.com', 'stale@test.com', 'anon@test.com']

      const response = await request('alice', '/recipients/check', { method: 'POST', body: { emails } })

      expect((await response.json()).recipients).toEqual(emails.map((email) => ({ email, status: 'unavailable' })))
    })

    it('refuses an untrusted caller device', async () => {
      await createAccount('alice', { trusted: false })
      const response = await request('alice', '/recipients/check', { method: 'POST', body: { emails: ['b@test.com'] } })
      expect(response.status).toBe(403)
    })

    it('refuses an anonymous caller', async () => {
      await createAccount('anon', { anonymous: true })
      const response = await request('anon', '/recipients/check', { method: 'POST', body: { emails: ['b@test.com'] } })
      expect(response.status).toBe(403)
      expect((await response.json()).code).toBe('ANONYMOUS_SHARE_FORBIDDEN')
    })
  })

  describe('rate limits', () => {
    it('charges a lookup one point per email', () => {
      expect(countLookupEmails({ emails: ['a@test.com', 'b@test.com', 'c@test.com'] })).toBe(3)
      expect(countLookupEmails({})).toBe(1)
    })

    it('puts the lookup limiter on the lookup only, after the session resolves', async () => {
      const { rateLimit, seenUserIds } = createRejectingRateLimit()
      mountApp({ lookupRateLimit: rateLimit })
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')

      const lookup = await request('alice', '/recipients/check', { method: 'POST', body: { emails: ['b@test.com'] } })

      expect(lookup.status).toBe(429)
      expect(seenUserIds).toEqual(['alice'])
      expect((await request('alice', `/${shareId}`)).status).toBe(404)
      expect((await putShare('alice')).status).toBe(201)
    })

    it('puts the share limiter on storing a share only', async () => {
      const { rateLimit, seenUserIds } = createRejectingRateLimit()
      mountApp({ shareRateLimit: rateLimit })
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')

      expect((await putShare('alice')).status).toBe(429)
      expect(seenUserIds).toEqual(['alice'])
      const lookup = await request('alice', '/recipients/check', { method: 'POST', body: { emails: ['b@test.com'] } })
      expect(lookup.status).toBe(200)
    })
  })

  describe('POST /shares/:shareId', () => {
    it('stores the share, syncs it to both sides and emails the recipient in the sharer’s language', async () => {
      await shareWithBob()

      const [sent] = await sentRows('alice')
      expect(sent).toEqual({
        id: shareId,
        userId: 'alice',
        chatThreadId: 'thread-1',
        recipients: JSON.stringify([{ userId: 'bob', name: 'Name bob', email: 'bob@test.com' }]),
        version: 1,
        updatedAt: expect.any(String),
      })
      expect(new Date(sent!.updatedAt).toISOString()).toBe(sent!.updatedAt)

      expect(await receivedRows('bob')).toEqual([
        {
          id: shareId,
          userId: 'bob',
          ownerUserId: 'alice',
          ownerName: 'Name alice',
          ownerEmail: 'alice@test.com',
          encryptedTitle: 'title-ciphertext',
          sealedShareKey,
          inboxVersion: 1,
          updatedAt: expect.any(String),
        },
      ])
      expect(await receivedRows('alice')).toEqual([])

      const opened = await (await request('bob', `/${shareId}`)).json()
      expect(opened.encryptedSnapshot).toBe('snapshot-ciphertext')

      expect(sentEmails).toEqual([
        {
          to: 'bob@test.com',
          sharerName: 'Name alice',
          sharerEmail: 'alice@test.com',
          shareUrl: `https://app.test/shared/${shareId}`,
          locale: 'de',
        },
      ])
    })

    it('replaces the share in place and emails only the people it adds', async () => {
      await shareWithBob()
      await createAccount('carol')
      sentEmails = []

      const response = await putShare('alice', {
        encryptedSnapshot: 'newer-snapshot',
        recipients: [recipient('carol')],
        replacesVersion: await shareVersion(),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ id: shareId, version: 2 })
      expect((await request('bob', `/${shareId}`)).status).toBe(404)
      expect((await (await request('carol', `/${shareId}`)).json()).encryptedSnapshot).toBe('newer-snapshot')
      expect(sentEmails.map((email) => email.to)).toEqual(['carol@test.com'])
      expect(await db.select().from(chatSharesTable)).toHaveLength(1)
      expect(await receivedRows('bob')).toEqual([])
      expect(await receivedRows('carol')).toHaveLength(1)
      const [sent] = await sentRows('alice')
      expect(sent!.version).toBe(2)
      expect(JSON.parse(sent!.recipients)).toEqual([{ userId: 'carol', name: 'Name carol', email: 'carol@test.com' }])
    })

    it('replaces every sealed key when the recipients stay the same', async () => {
      await shareWithBob()
      sentEmails = []
      const resealed = 'R'.repeat(sealedShareKey.length)

      const response = await putShare('alice', {
        recipients: [{ ...recipient('bob'), sealedShareKey: resealed }],
        replacesVersion: await shareVersion(),
      })

      expect(response.status).toBe(200)
      expect((await (await request('bob', `/${shareId}`)).json()).sealedShareKey).toBe(resealed)
      expect(sentEmails).toEqual([])
    })

    it('does not email someone again for being removed and added back, or for a share stopped and made again', async () => {
      await shareWithBob()
      await createAccount('carol')
      expect(sentEmails.map((email) => email.to)).toEqual(['bob@test.com'])
      sentEmails = []

      await putShare('alice', { recipients: [recipient('carol')], replacesVersion: await shareVersion() })
      await putShare('alice', { recipients: [recipient('bob')], replacesVersion: await shareVersion() })
      expect((await request('alice', `/${shareId}`, { method: 'DELETE' })).status).toBe(204)
      expect((await putShare('alice', { recipients: [recipient('bob'), recipient('carol')] })).status).toBe(201)

      expect(sentEmails.map((email) => email.to)).toEqual(['carol@test.com'])
    })

    it('emails them again once a day has passed', async () => {
      await shareWithBob()
      sentEmails = []
      await db.update(chatShareNotificationsTable).set({ notifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      expect((await request('alice', `/${shareId}`, { method: 'DELETE' })).status).toBe(204)

      expect((await putShare('alice')).status).toBe(201)

      expect(sentEmails.map((email) => email.to)).toEqual(['bob@test.com'])
    })

    it('refuses a replace of a version the share no longer has, keeping the newer one', async () => {
      await shareWithBob()
      await createAccount('carol')
      const readVersion = await shareVersion()
      expect((await putShare('alice', { encryptedSnapshot: 'first', replacesVersion: readVersion })).status).toBe(200)

      const response = await putShare('alice', { recipients: [recipient('carol')], replacesVersion: readVersion })

      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('SHARE_CHANGED')
      expect((await (await request('bob', `/${shareId}`)).json()).encryptedSnapshot).toBe('first')
      const [sent] = await sentRows('alice')
      expect(sent!.version).toBe(2)
      expect(sent!.recipients).toEqual(JSON.stringify([{ userId: 'bob', name: 'Name bob', email: 'bob@test.com' }]))
    })

    it('refuses a replace without a version, or of a share stopped since', async () => {
      await shareWithBob()
      const readVersion = await shareVersion()
      expect((await (await putShare('alice')).json()).code).toBe('SHARE_CHANGED')

      expect((await request('alice', `/${shareId}`, { method: 'DELETE' })).status).toBe(204)
      const response = await putShare('alice', { replacesVersion: readVersion })

      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('SHARE_CHANGED')
      expect(await db.select().from(chatSharesTable)).toEqual([])
    })

    it('spends the proof even when the write is refused', async () => {
      await shareWithBob()
      const proof = await shareProof('alice')
      expect((await (await putShare('alice', { proof }, otherShareId)).json()).code).toBe('CHAT_ALREADY_SHARED')

      expect((await putShare('alice', { proof, replacesVersion: await shareVersion() })).status).toBe(403)
    })

    it('refuses a share without a proof', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')
      expect((await putShare('alice', { proof: undefined })).status).toBe(422)
    })

    it('refuses a proof for another operation', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')

      const response = await putShare('alice', { proof: { ...(await shareProof('alice')), operation: 'inbox' } })

      expect(response.status).toBe(403)
      expect(await db.select().from(chatSharesTable)).toEqual([])
    })

    it('refuses a proof signed by a key that is not the account’s', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')

      const response = await putShare('alice', { proof: await shareProof('alice', await generateSigningKeypair()) })

      expect(response.status).toBe(403)
      expect(await db.select().from(chatSharesTable)).toEqual([])
    })

    it.each([
      ['yourself', [recipient('alice')], 400, undefined],
      ['the same person twice', [recipient('bob'), recipient('bob')], 400, undefined],
      ['someone without an inbox key', [recipient('noinbox')], 409, 'RECIPIENT_CHANGED'],
      ['someone whose inbox key went stale', [recipient('stale')], 409, 'RECIPIENT_CHANGED'],
      ['an anonymous account', [recipient('anon')], 409, 'RECIPIENT_CHANGED'],
      ['a superseded inbox version', [recipient('bob', 2)], 409, 'RECIPIENT_CHANGED'],
    ])('refuses sharing with %s', async (_, recipients, status, code) => {
      await createAccount('alice')
      await createAccount('bob')
      await createAccount('noinbox', { inbox: 'none' })
      await createAccount('stale', { inbox: 'stale' })
      await createAccount('anon', { anonymous: true })
      await createThread('alice')

      const response = await putShare('alice', { recipients })

      expect(response.status).toBe(status)
      if (code) {
        expect((await response.json()).code).toBe(code)
      }
      expect(await db.select().from(chatSharesTable)).toEqual([])
    })

    it('refuses a chat the caller does not own', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createThread('bob')
      const response = await putShare('alice')
      expect(response.status).toBe(404)
      expect((await response.json()).code).toBe('CHAT_NOT_FOUND')
    })

    it('refuses a deleted chat', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')
      await db.update(chatThreadsTable).set({ deletedAt: new Date() }).where(eq(chatThreadsTable.id, 'thread-1'))
      expect((await putShare('alice')).status).toBe(404)
    })

    it('refuses a second share of the same chat under another id', async () => {
      await shareWithBob()
      const response = await putShare('alice', {}, otherShareId)
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('CHAT_ALREADY_SHARED')
    })

    it('refuses reusing a share id for another chat', async () => {
      await shareWithBob()
      await createThread('alice', 'thread-2')
      const response = await putShare('alice', { chatThreadId: 'thread-2' })
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('SHARE_ID_TAKEN')
    })

    it('refuses someone else’s share id', async () => {
      await shareWithBob()
      await createThread('bob', 'thread-bob')
      const response = await putShare('bob', { chatThreadId: 'thread-bob', recipients: [recipient('alice')] })
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('SHARE_ID_TAKEN')
    })

    it('refuses a sealed key that is not the size of a share-key seal', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createThread('alice')
      const response = await putShare('alice', { recipients: [{ ...recipient('bob'), sealedShareKey: 'short' }] })
      expect(response.status).toBe(422)
    })
  })

  describe('reading', () => {
    it('serves a share to nobody but its recipients', async () => {
      await shareWithBob()
      await createAccount('mallory')
      expect((await request('mallory', `/${shareId}`)).status).toBe(404)
      expect(await receivedRows('mallory')).toEqual([])
    })

    it('stops serving a share once its chat is deleted', async () => {
      await shareWithBob()
      await db.update(chatThreadsTable).set({ deletedAt: new Date() }).where(eq(chatThreadsTable.id, 'thread-1'))

      expect((await request('bob', `/${shareId}`)).status).toBe(404)
    })

    it.each([
      ['a PATCH setting deleted_at', { op: 'PATCH', data: { deleted_at: new Date().toISOString() } }],
      ['a PUT carrying deleted_at', { op: 'PUT', data: { title: 't', deleted_at: new Date().toISOString() } }],
      ['a DELETE', { op: 'DELETE' }],
    ] as const)('deletes a chat’s shares when %s syncs up', async (_, operation) => {
      await shareWithBob()
      await applyOperation(db, { type: 'chat_threads', id: 'thread-1', ...operation }, 'alice')
      expect(await db.select().from(chatSharesTable)).toEqual([])
      expect(await db.select().from(chatShareNotificationsTable)).toEqual([])
      expect(await sentRows('alice')).toEqual([])
      expect(await receivedRows('bob')).toEqual([])
    })

    it.each([
      ['a rename PATCH', { op: 'PATCH', data: { title: 'renamed' } }],
      ['a PATCH clearing deleted_at', { op: 'PATCH', data: { deleted_at: null } }],
      ['a PUT of a live chat', { op: 'PUT', data: { title: 't', deleted_at: null } }],
    ] as const)('keeps a chat’s shares on %s', async (_, operation) => {
      await shareWithBob()
      await applyOperation(db, { type: 'chat_threads', id: 'thread-1', ...operation }, 'alice')
      expect(await db.select().from(chatSharesTable)).toHaveLength(1)
      expect(await receivedRows('bob')).toHaveLength(1)
    })

    it('leaves the owner’s shares alone when another account deletes a chat with the same id', async () => {
      await shareWithBob()
      await applyOperation(db, { op: 'DELETE', type: 'chat_threads', id: 'thread-1' }, 'bob')
      expect(await db.select().from(chatSharesTable)).toHaveLength(1)
    })

    it.each([
      ['a PUT', { op: 'PUT', data: { owner_name: 'Forged' } }],
      ['a PATCH', { op: 'PATCH', data: { encrypted_title: 'forged' } }],
      ['a DELETE', { op: 'DELETE' }],
    ] as const)('ignores %s of a synced share row', async (_, operation) => {
      await shareWithBob()
      const before = { sent: await sentRows('alice'), received: await receivedRows('bob') }
      const warn = spyOn(console, 'warn').mockImplementation(() => {})

      expect(await applyOperation(db, { type: 'received_shares', id: shareId, ...operation }, 'bob')).toBe(true)
      expect(await applyOperation(db, { type: 'sent_shares', id: shareId, ...operation }, 'alice')).toBe(true)

      expect({ sent: await sentRows('alice'), received: await receivedRows('bob') }).toEqual(before)
      expect(warn).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })
  })

  describe('revoking', () => {
    it('lets the owner stop sharing, and nobody else', async () => {
      await shareWithBob()
      expect((await request('bob', `/${shareId}`, { method: 'DELETE' })).status).toBe(404)
      expect((await request('alice', `/${shareId}`, { method: 'DELETE' })).status).toBe(204)
      expect(await db.select().from(chatSharesTable)).toEqual([])
      expect(await db.select().from(chatShareRecipientsTable)).toEqual([])
      expect(await sentRows('alice')).toEqual([])
      expect(await receivedRows('bob')).toEqual([])
    })

    it('removes one recipient and keeps the share for the others', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createAccount('carol')
      await createThread('alice')
      await putShare('alice', { recipients: [recipient('bob'), recipient('carol')] })

      expect((await request('alice', `/${shareId}/recipients/bob`, { method: 'DELETE' })).status).toBe(204)

      expect((await request('bob', `/${shareId}`)).status).toBe(404)
      expect((await request('carol', `/${shareId}`)).status).toBe(200)
      expect(await receivedRows('bob')).toEqual([])
      expect(await receivedRows('carol')).toHaveLength(1)
      expect(JSON.parse((await sentRows('alice'))[0]!.recipients)).toEqual([
        { userId: 'carol', name: 'Name carol', email: 'carol@test.com' },
      ])
    })

    it('deletes the share when its last recipient is removed', async () => {
      await shareWithBob()
      expect((await request('alice', `/${shareId}/recipients/bob`, { method: 'DELETE' })).status).toBe(204)
      expect(await db.select().from(chatSharesTable)).toEqual([])
      expect(await sentRows('alice')).toEqual([])
    })

    it('refuses removing a recipient from someone else’s share, or one who is not on it', async () => {
      await shareWithBob()
      await createAccount('carol')
      expect((await request('bob', `/${shareId}/recipients/bob`, { method: 'DELETE' })).status).toBe(404)
      expect((await request('alice', `/${shareId}/recipients/carol`, { method: 'DELETE' })).status).toBe(404)
      expect(await db.select().from(chatShareRecipientsTable)).toHaveLength(1)
    })
  })

  describe('DELETE /shares/received/:shareId', () => {
    it('lets a recipient remove a chat shared with them, keeping it for the others', async () => {
      await createAccount('alice')
      await createAccount('bob')
      await createAccount('carol')
      await createThread('alice')
      await putShare('alice', { recipients: [recipient('bob'), recipient('carol')] })

      expect((await request('bob', `/received/${shareId}`, { method: 'DELETE' })).status).toBe(204)

      expect(await receivedRows('bob')).toEqual([])
      expect(await receivedRows('carol')).toHaveLength(1)
      expect(JSON.parse((await sentRows('alice'))[0]!.recipients)).toEqual([
        { userId: 'carol', name: 'Name carol', email: 'carol@test.com' },
      ])
      expect((await request('carol', `/${shareId}`)).status).toBe(200)
    })

    it('deletes the share once its last recipient removes it', async () => {
      await shareWithBob()
      expect((await request('bob', `/received/${shareId}`, { method: 'DELETE' })).status).toBe(204)
      expect(await db.select().from(chatSharesTable)).toEqual([])
      expect(await sentRows('alice')).toEqual([])
      expect(await receivedRows('bob')).toEqual([])
    })

    it('refuses someone the share was not sent to', async () => {
      await shareWithBob()
      expect((await request('alice', `/received/${shareId}`, { method: 'DELETE' })).status).toBe(404)
      expect(await db.select().from(chatShareRecipientsTable)).toHaveLength(1)
    })
  })

  describe('deleting an account', () => {
    it('deletes the shares sent only to it, and keeps the ones others are still on', async () => {
      await shareWithBob()
      await createAccount('carol')
      await createThread('alice', 'thread-2')
      await putShare(
        'alice',
        { chatThreadId: 'thread-2', recipients: [recipient('bob'), recipient('carol')] },
        otherShareId,
      )

      await deleteUser(db, 'bob')

      const remaining = await db.select({ id: chatSharesTable.id }).from(chatSharesTable)
      expect(remaining).toEqual([{ id: otherShareId }])
      expect((await request('carol', `/${otherShareId}`)).status).toBe(200)
      const sent = await sentRows('alice')
      expect(
        sent.map((row) => [row.id, JSON.parse(row.recipients).map((user: { userId: string }) => user.userId)]),
      ).toEqual([[otherShareId, ['carol']]])
      expect(await receivedRows('carol')).toHaveLength(1)
    })

    it('deletes the owner’s shares with the owner, and every recipient’s synced row of them', async () => {
      await shareWithBob()
      await deleteUser(db, 'alice')
      expect(await db.select().from(chatSharesTable)).toEqual([])
      expect(await receivedRows('bob')).toEqual([])
    })
  })
})
