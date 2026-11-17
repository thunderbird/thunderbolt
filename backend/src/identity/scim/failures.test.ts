/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuth } from '@/auth/auth'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { auditEvent } from '@/db/schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import { createScimClient, keycloakUser, uniqueSuffix } from '@/test-utils/scim'
import { beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { createScimConnection } from './connections'
import { createScimRequestHandler, defaultScimRateLimits, scimErrorResponse, scimMountPath } from './request'

describe('rejected SCIM requests', () => {
  let db: IsolatedTestDb['db']
  let auth: Auth
  let handle: (request: Request) => Promise<Response>
  let actorId: string

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    auth = createAuth(db)
    const app = new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin)
    handle = (request) => app.handle(request)
    actorId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
  })

  const setUp = async () => {
    const { connection, credential, token } = await createScimConnection(auth, {
      actorId,
      name: `IdP ${uniqueSuffix()}`,
    })
    return { connection, credential, scim: createScimClient(handle, token) }
  }

  const failuresFor = (connectionId: string) =>
    db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.connectionId, connectionId),
          eq(auditEvent.action, 'scim.request'),
          eq(auditEvent.outcome, 'failure'),
        ),
      )

  const newUser = () => {
    const email = `user-${uniqueSuffix()}@example.com`
    return keycloakUser(email, email, crypto.randomUUID())
  }

  it('records a refusal the pipeline makes, attributed to the connection and credential', async () => {
    const { connection, credential, scim } = await setUp()
    const { externalId: _, ...withoutExternalId } = newUser()

    expect((await scim.call('POST', '/Users', { body: withoutExternalId })).status).toBe(400)

    const [failure] = await failuresFor(connection.id)
    expect(failure).toMatchObject({
      actorType: 'scim_connection',
      actorId: connection.id,
      credentialId: credential.credentialId,
      reason: 'invalidValue',
      metadata: { method: 'POST', resourceType: 'Users', status: 400, scimType: 'invalidValue' },
    })
  })

  it('records a refusal from the plugin and one that changes externalId, with the resource', async () => {
    const { connection, scim } = await setUp()
    const body = newUser()
    const created = await scim.call('POST', '/Users', { body })
    expect(created.status).toBe(201)

    expect((await scim.call('POST', '/Users', { body })).status).toBe(409)
    expect(
      (await scim.patch(`/Users/${created.body.id}`, [{ op: 'replace', path: 'externalId', value: 'another' }])).status,
    ).toBeGreaterThanOrEqual(400)

    const failures = await failuresFor(connection.id)
    expect(failures).toHaveLength(2)
    expect(failures.find((failure) => failure.reason === 'uniqueness')).toBeDefined()
    expect(failures.find((failure) => failure.targetId === created.body.id)).toMatchObject({ targetType: 'scim_user' })
  })

  it('records nothing for a success or a token that never authenticated', async () => {
    const { connection, scim } = await setUp()
    const before = await db.$count(auditEvent, eq(auditEvent.action, 'scim.request'))

    expect((await scim.call('POST', '/Users', { body: newUser() })).status).toBe(201)
    expect((await scim.call('GET', '/Users', { token: 'not-a-real-token' })).status).toBe(401)

    expect(await failuresFor(connection.id)).toHaveLength(0)
    expect(await db.$count(auditEvent, eq(auditEvent.action, 'scim.request'))).toBe(before)
  })

  it.each([true, false])(
    'records at most its budget of rejections per credential, and still answers the rest (rate limiting on: %p)',
    async (rateLimitEnabled) => {
      const { connection, token } = await createScimConnection(auth, { actorId, name: `IdP ${uniqueSuffix()}` })
      const handler = createScimRequestHandler({
        handler: auth.handler,
        database: db,
        rateLimit: { enabled: rateLimitEnabled },
        limits: { ...defaultScimRateLimits, recordedFailuresPerCredential: { max: 2, durationSecs: 3600 } },
      })
      const scim = createScimClient((request) => handler(request, `client-${uniqueSuffix()}`), token)
      const { externalId: _, ...withoutExternalId } = newUser()

      for (let attempt = 0; attempt < 4; attempt++) {
        expect((await scim.call('POST', '/Users', { body: withoutExternalId })).status).toBe(400)
      }

      expect(await failuresFor(connection.id)).toHaveLength(2)
    },
  )

  it('records nothing for a concurrent-write conflict the retry resolves', async () => {
    const { connection, token } = await createScimConnection(auth, { actorId, name: `IdP ${uniqueSuffix()}` })
    let conflicted = false
    // The first create loses an optimistic-lock race, after authenticating; the retry goes through.
    const racingHandler = async (request: Request) => {
      if (request.method !== 'POST' || conflicted) {
        return auth.handler(request)
      }
      conflicted = true
      await auth.handler(
        new Request(`${new URL(request.url).origin}${scimMountPath}/Users?count=0`, {
          headers: { authorization: request.headers.get('authorization') ?? '' },
        }),
      )
      return scimErrorResponse(409, 'The SCIM identity changed concurrently; retry the request')
    }
    const handler = createScimRequestHandler({ handler: racingHandler, database: db, rateLimit: { enabled: false } })
    const scim = createScimClient((request) => handler(request, `client-${uniqueSuffix()}`), token)

    expect((await scim.call('POST', '/Users', { body: newUser() })).status).toBe(201)

    expect(conflicted).toBe(true)
    expect(await failuresFor(connection.id)).toHaveLength(0)
  })
})
