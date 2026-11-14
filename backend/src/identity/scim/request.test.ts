/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { user } from '@/db/auth-schema'
import { rateLimits } from '@/db/rate-limit-schema'
import { scimGroup, scimUser } from '@/db/scim-schema'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { insertTestUsers } from '@/test-utils/identity'
import {
  createScimClient,
  entraLegacyGroupSchema,
  entraUser,
  keycloakUser,
  scimEnterpriseSchema,
  type ScimClient,
  scimGroupSchema,
  scimUserSchema,
  uniqueSuffix,
} from '@/test-utils/scim'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq, like } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { createScimConnection } from './connections'
import { createScimRequestHandler } from './request'

const directoryExtension = 'urn:ietf:params:scim:schemas:extension:CustomExtensionName:2.0:User'

describe('SCIM request pipeline', () => {
  let db: IsolatedTestDb['db']
  let auth: Auth
  let app: { handle: (request: Request) => Promise<Response> }
  let scim: ScimClient
  let other: ScimClient

  const createUser = async (body: unknown, client = scim) => {
    const response = await client.call('POST', '/Users', { body })
    expect(response.status).toBe(201)
    return response.body
  }

  const storedUser = async (scimUserId: string) => {
    const [row] = await db.select().from(scimUser).where(eq(scimUser.id, scimUserId))
    const [linked] = await db.select().from(user).where(eq(user.id, row.userId))
    return { scimUser: row, user: linked }
  }

  beforeAll(async () => {
    ;({ db } = await getSharedIsolatedTestDb())
    const created = createBetterAuthPlugin(db)
    auth = created.auth
    app = new Elysia({ prefix: '/v1' }).use(created.plugin)
    const adminId = `scim-admin-${uniqueSuffix()}`
    await insertTestUsers(db, { id: adminId, name: 'Admin', email: `${adminId}@example.com`, emailVerified: true })
    const first = await createScimConnection(auth, { actorId: adminId, name: `Entra ${uniqueSuffix()}` })
    const second = await createScimConnection(auth, { actorId: adminId, name: `Keycloak ${uniqueSuffix()}` })
    scim = createScimClient((request) => app.handle(request), first.token)
    other = createScimClient((request) => app.handle(request), second.token)
  })

  describe('mount', () => {
    it('reaches the plugin for every method', async () => {
      const created = await createUser(entraUser(`methods-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`))
      expect((await scim.call('GET', `/Users/${created.id}`)).status).toBe(200)
      const replaced = await scim.call('PUT', `/Users/${created.id}`, {
        body: { ...entraUser(created.userName!, created.externalId!), displayName: 'Replaced' },
      })
      expect(replaced.status).toBe(200)
      expect(replaced.body.displayName).toBe('Replaced')
      expect((await scim.patch(`/Users/${created.id}`, [{ op: 'replace', path: 'active', value: false }])).status).toBe(
        200,
      )
      expect((await scim.call('DELETE', `/Users/${created.id}`)).status).toBe(204)
    })

    it('answers without a token in SCIM error format', async () => {
      const response = await scim.call('GET', '/Users', { token: null })
      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).toContain('application/scim+json')
    })
  })

  describe('externalId', () => {
    it('refuses a user created without externalId, with a clear SCIM error', async () => {
      const userName = `noext-${uniqueSuffix()}@contoso.test`
      const { externalId: _, ...body } = entraUser(userName, 'unused')
      for (const candidate of [body, { ...body, externalId: '' }]) {
        const response = await scim.call('POST', '/Users', { body: candidate })
        expect(response.status).toBe(400)
        expect(response.headers.get('content-type')).toContain('application/scim+json')
        expect(response.body).toMatchObject({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
          status: '400',
          scimType: 'invalidValue',
        })
        expect(response.body.detail).toContain('externalId is required')
      }
      expect(await db.$count(scimUser, eq(scimUser.userName, userName))).toBe(0)
    })

    it('refuses any PATCH or PUT that changes or removes a set externalId', async () => {
      const externalId = `oid-${uniqueSuffix()}`
      const created = await createUser(entraUser(`lock-${uniqueSuffix()}@contoso.test`, externalId))
      const attempts = [
        () => scim.patch(`/Users/${created.id}`, [{ op: 'add', path: 'externalId', value: 'someone-else' }]),
        () => scim.patch(`/Users/${created.id}`, [{ op: 'Replace', path: 'externalId', value: 'someone-else' }]),
        () =>
          scim.patch(`/Users/${created.id}`, [
            { op: 'replace', path: 'urn:ietf:params:scim:schemas:core:2.0:User:externalId', value: 'someone-else' },
          ]),
        () => scim.patch(`/Users/${created.id}`, [{ op: 'remove', path: 'externalId' }]),
        () => scim.patch(`/Users/${created.id}`, [{ op: 'replace', value: { externalId: 'someone-else' } }]),
        () => scim.call('PUT', `/Users/${created.id}`, { body: entraUser(created.userName!, 'someone-else') }),
      ]
      for (const attempt of attempts) {
        const response = await attempt()
        expect(response.status).toBe(400)
        expect(response.body.scimType).toBe('mutability')
      }
      expect((await storedUser(created.id!)).scimUser.externalId).toBe(externalId)
    })

    it('reads the stored externalId whole, whatever the query asks to project away', async () => {
      const externalId = `oid-${uniqueSuffix()}`
      const created = await createUser(entraUser(`hidden-${uniqueSuffix()}@contoso.test`, externalId))
      const query = '?excludedAttributes=externalId'
      const patched = await scim.patch(`/Users/${created.id}${query}`, [
        { op: 'replace', path: 'externalId', value: 'someone-else' },
      ])
      expect(patched.status).toBe(400)
      expect(patched.body.scimType).toBe('mutability')
      const replaced = await scim.call('PUT', `/Users/${created.id}${query}`, {
        body: entraUser(created.userName!, 'someone-else'),
      })
      expect(replaced.status).toBe(400)
      expect(replaced.body.scimType).toBe('mutability')
      expect((await storedUser(created.id!)).scimUser.externalId).toBe(externalId)
    })

    it('refuses a blank path and a second spelling hidden behind the stored value', async () => {
      const externalId = `oid-${uniqueSuffix()}`
      const created = await createUser(entraUser(`spelling-${uniqueSuffix()}@contoso.test`, externalId))
      for (const operation of [
        { op: 'replace', path: '', value: { externalId: 'someone-else' } },
        {
          op: 'replace',
          value: { externalId, 'urn:ietf:params:scim:schemas:core:2.0:User:externalId': 'someone-else' },
        },
      ]) {
        const response = await scim.patch(`/Users/${created.id}`, [operation])
        expect(response.status).toBe(400)
        expect(response.body.scimType).toBe('mutability')
      }
      expect((await storedUser(created.id!)).scimUser.externalId).toBe(externalId)
    })

    it('accepts the same externalId again, and a PUT that leaves it out keeps it', async () => {
      const externalId = `oid-${uniqueSuffix()}`
      const created = await createUser(entraUser(`same-${uniqueSuffix()}@contoso.test`, externalId))
      const resent = await scim.patch(`/Users/${created.id}`, [
        { op: 'add', path: 'externalId', value: externalId },
        { op: 'replace', path: 'displayName', value: 'Same Id' },
      ])
      expect(resent.status).toBe(200)
      const { externalId: _, ...withoutExternalId } = entraUser(created.userName!, externalId)
      const replaced = await scim.call('PUT', `/Users/${created.id}`, { body: withoutExternalId })
      expect(replaced.status).toBe(200)
      expect(replaced.body.externalId).toBe(externalId)
    })
  })

  describe('compatibility', () => {
    it('applies a Keycloak email change sent as emails[value eq ...].value, with the bundled userName change', async () => {
      const oldEmail = `alice-${uniqueSuffix()}@example.com`
      const newEmail = `alice.new-${uniqueSuffix()}@example.com`
      const created = await createUser(keycloakUser(`alice-${uniqueSuffix()}`, oldEmail, crypto.randomUUID()))
      const response = await scim.patch(`/Users/${created.id}`, [
        { op: 'replace', path: `emails[value eq "${oldEmail}"].value`, value: newEmail },
        { op: 'replace', path: 'userName', value: `alice2-${uniqueSuffix()}` },
      ])
      expect(response.status).toBe(200)
      expect(response.body.emails).toEqual([{ value: newEmail, type: 'work', primary: true }])
      const stored = await storedUser(created.id!)
      expect(stored.scimUser.primaryEmail).toBe(newEmail)
      expect(stored.scimUser.userName).toBe(response.body.userName as string)
      expect(stored.user.email).toBe(newEmail)
      expect(stored.user.emailVerified).toBe(true)
    })

    it('answers an emails[value eq ...] filter that matches nothing with noTarget', async () => {
      const created = await createUser(entraUser(`notarget-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`))
      const response = await scim.patch(`/Users/${created.id}`, [
        { op: 'replace', path: 'emails[value eq "nobody@example.com"].value', value: 'x@example.com' },
      ])
      expect(response.status).toBe(400)
      expect(response.body.scimType).toBe('noTarget')
    })

    it('leaves the Better Auth email verified on a SCIM create', async () => {
      const created = await createUser(entraUser(`verified-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`))
      expect((await storedUser(created.id!)).user.emailVerified).toBe(true)
    })

    it('accepts and ignores Entra directory-extension schemas', async () => {
      const created = await createUser({
        ...entraUser(`ext-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`),
        schemas: [scimUserSchema, scimEnterpriseSchema, directoryExtension],
        [directoryExtension]: { costCenter: '42' },
      })
      expect(created.schemas).not.toContain(directoryExtension)

      const mixed = await scim.patch(`/Users/${created.id}`, [
        { op: 'Replace', path: `${directoryExtension}:costCenter`, value: '43' },
        { op: 'Replace', value: { displayName: 'Extended', [directoryExtension]: { costCenter: '44' } } },
      ])
      expect(mixed.status).toBe(200)
      expect(mixed.body.displayName).toBe('Extended')

      const extensionOnly = await scim.patch(`/Users/${created.id}`, [
        { op: 'Add', path: `${directoryExtension}:costCenter`, value: '45' },
      ])
      expect(extensionOnly.status).toBe(200)
      expect(extensionOnly.body.id).toBe(created.id)
    })

    it("accepts Entra's legacy group schema marker", async () => {
      const response = await scim.call('POST', '/Groups', {
        body: {
          schemas: [scimGroupSchema, entraLegacyGroupSchema],
          externalId: crypto.randomUUID(),
          displayName: `Legacy ${uniqueSuffix()}`,
        },
      })
      expect(response.status).toBe(201)
    })
  })

  describe('connection isolation', () => {
    it("connection A's token cannot read or change connection B's resources", async () => {
      const theirs = await createUser(
        entraUser(`theirs-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`),
        other,
      )
      const theirGroup = await other.call('POST', '/Groups', {
        body: { schemas: [scimGroupSchema], displayName: `Theirs ${uniqueSuffix()}` },
      })
      const mine = await createUser(entraUser(`mine-${uniqueSuffix()}@contoso.test`, `oid-${uniqueSuffix()}`))

      expect((await scim.call('GET', `/Users/${theirs.id}`)).status).toBe(404)
      expect((await scim.patch(`/Users/${theirs.id}`, [{ op: 'replace', path: 'active', value: false }])).status).toBe(
        404,
      )
      expect(
        (await scim.call('PUT', `/Users/${theirs.id}`, { body: entraUser(theirs.userName!, theirs.externalId!) }))
          .status,
      ).toBe(404)
      expect((await scim.call('DELETE', `/Users/${theirs.id}`)).status).toBe(404)
      expect((await scim.call('GET', `/Groups/${theirGroup.body.id}`)).status).toBe(404)
      expect(
        (await scim.patch(`/Groups/${theirGroup.body.id}`, [{ op: 'replace', path: 'displayName', value: 'Mine' }]))
          .status,
      ).toBe(404)
      expect((await scim.call('DELETE', `/Groups/${theirGroup.body.id}`)).status).toBe(404)

      const filtered = await scim.call('GET', `/Users?filter=${encodeURIComponent(`userName eq "${theirs.userName}"`)}`)
      expect(filtered.body.totalResults).toBe(0)

      const foreignMember = await other.patch(`/Groups/${theirGroup.body.id}`, [
        { op: 'add', path: 'members', value: [{ value: mine.id }] },
      ])
      expect(foreignMember.status).toBe(400)
      expect(await db.$count(scimGroup, eq(scimGroup.id, theirGroup.body.id!))).toBe(1)
      expect((await storedUser(theirs.id!)).scimUser.active).toBe(true)
    })
  })

  describe('rate limits', () => {
    const handlerWithLimits = () =>
      createScimRequestHandler({
        handler: auth.handler,
        database: db,
        rateLimit: { enabled: true },
        limits: { perCredential: { max: 3, durationSecs: 60 }, authFailuresPerIp: { max: 2, durationSecs: 60 } },
      })

    it('answers over the per-credential budget with a SCIM 429 and Retry-After, per token', async () => {
      const handle = handlerWithLimits()
      const ip = `client-${uniqueSuffix()}`
      const limited = createScimClient((request) => handle(request, ip), (await connectionToken()).token)
      const fresh = createScimClient((request) => handle(request, ip), (await connectionToken()).token)
      const statuses = []
      for (let index = 0; index < 4; index++) {
        statuses.push((await limited.call('GET', '/Users')).status)
      }
      expect(statuses).toEqual([200, 200, 200, 429])
      const refused = await limited.call('GET', '/Users')
      expect(refused.headers.get('content-type')).toContain('application/scim+json')
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(refused.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '429' })
      expect((await fresh.call('GET', '/Users')).status).toBe(200)
    })

    it('charges no bucket for discovery, which answers without a token', async () => {
      const handle = handlerWithLimits()
      const madeUp = `made-up-${uniqueSuffix()}`
      const client = createScimClient((request) => handle(request, `discovery-${uniqueSuffix()}`), madeUp)
      for (const path of ['/ServiceProviderConfig', '/Schemas', '/ResourceTypes']) {
        expect((await client.call('GET', path)).status).toBe(200)
      }
      const key = `scim:token:${createHash('sha256').update(madeUp).digest('hex')}`
      expect(await db.$count(rateLimits, like(rateLimits.key, key))).toBe(0)
    })

    it('stops an IP after too many rejected tokens, without touching other IPs', async () => {
      const handle = handlerWithLimits()
      const { token } = await connectionToken()
      const ip = `sprayer-${uniqueSuffix()}`
      const sprayer = createScimClient((request) => handle(request, ip), `not-a-token-${uniqueSuffix()}`)
      expect((await sprayer.call('GET', '/Users')).status).toBe(401)
      expect((await sprayer.call('GET', '/Users')).status).toBe(401)
      expect((await sprayer.call('GET', '/Users')).status).toBe(429)
      expect((await sprayer.call('GET', '/Users', { token })).status).toBe(429)
      const elsewhere = createScimClient((request) => handle(request, `elsewhere-${uniqueSuffix()}`), token)
      expect((await elsewhere.call('GET', '/Users')).status).toBe(200)
    })

    const connectionToken = async () => {
      const actorId = `scim-admin-${uniqueSuffix()}`
      await insertTestUsers(db, { id: actorId, name: 'Admin', email: `${actorId}@example.com`, emailVerified: true })
      return createScimConnection(auth, { actorId, name: `Limited ${uniqueSuffix()}` })
    }
  })
})

describe('SCIM write retries', () => {
  it('prepares each attempt from a fresh read, so a concurrent change is not undone', async () => {
    const reads = [
      [{ value: 'old@example.com', type: 'work', primary: true }],
      [
        { value: 'old@example.com', type: 'work', primary: true },
        { value: 'added@example.com', type: 'home' },
      ],
    ]
    const sentBodies: unknown[] = []
    let readCount = 0
    const handler = async (request: Request) => {
      if (request.method === 'GET') {
        const emails = reads[Math.min(readCount++, reads.length - 1)]
        return Response.json({ id: 'u1', externalId: 'kc-1', emails })
      }
      sentBodies.push(await request.json())
      return sentBodies.length === 1
        ? Response.json(
            { status: '409', detail: 'The SCIM identity changed concurrently; retry the request' },
            { status: 409 },
          )
        : Response.json({ id: 'u1' })
    }
    const { db } = await getSharedIsolatedTestDb()
    const handle = createScimRequestHandler({ handler, database: db, rateLimit: { enabled: false } })
    const client = createScimClient((request) => handle(request, 'retry-test'), 'token')
    const response = await client.patch('/Users/u1', [
      { op: 'replace', path: 'emails[value eq "old@example.com"].value', value: 'new@example.com' },
    ])
    expect(response.status).toBe(200)
    expect(readCount).toBe(2)
    expect(sentBodies[1]).toMatchObject({
      Operations: [
        {
          path: 'emails',
          value: [
            { value: 'new@example.com', type: 'work', primary: true },
            { value: 'added@example.com', type: 'home' },
          ],
        },
      ],
    })
  })
})
