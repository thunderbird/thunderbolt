/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createPowerSyncRoutes } from '@/api/powersync'
import { type Auth, createAuth } from '@/auth/auth'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { challengeTokenHeader, testSignInOtp } from '@/auth/otp-constants'
import * as settingsModule from '@/config/settings'
import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { auditEvent, identityConnection, membershipSource, orgMembership, ssoProvider, user } from '@/db/schema'
import { createFakeOidcIdps, type FakeOidcIdps, fakeOidcClientId } from '@/test-utils/fake-oidc'
import { createTestChallenge } from '@/test-utils/otp-challenge'
import { postgresTestUrl } from '@/test-utils/postgres'
import { createTestSettings } from '@/test-utils/settings'
import { defaultKeyHasher } from '@better-auth/api-key'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { createHmac } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import { Elysia } from 'elysia'
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import postgres from 'postgres'
import { ensureImplicitOrganization } from './organization'
import { ensureEnvSsoConnection, envSsoConnectionId, envSsoProviderId } from './sso-connections'

/*
 * An existing deployment upgrading to the release that adds organizations and connections, with
 * its environment unchanged: the database is migrated as the previous release left it, filled with
 * the rows it wrote, and then migrated and booted as the new release does.
 */

/** The last migration of the release before organizations. */
const lastOldMigration = '0046_passkey-continuity'

const migrationsFolder = resolve(import.meta.dir, '../../drizzle')

/** A temporary copy of the migrations that stops at `tag`, as the older release shipped them. */
const migrationsUpTo = async (tag: string) => {
  const folder = await mkdtemp(join(tmpdir(), 'migrations-'))
  await cp(migrationsFolder, folder, { recursive: true })
  const journalPath = join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] }
  const last = journal.entries.findIndex((entry) => entry.tag === tag)
  if (last === -1) {
    throw new Error(`No migration ${tag}`)
  }
  journal.entries = journal.entries.slice(0, last + 1)
  await writeFile(journalPath, JSON.stringify(journal))
  return folder
}

type FreshDatabase = {
  db: typeof DbType
  migrate: (folder: string) => Promise<void>
  close: () => Promise<void>
}

const openPglite = async (): Promise<FreshDatabase> => {
  const client = new PGlite()
  const db = drizzlePglite({ client, schema })
  return {
    db: db as unknown as typeof DbType,
    migrate: (folder) => migratePglite(db, { migrationsFolder: folder }),
    close: () => client.close(),
  }
}

const openPostgres = async (): Promise<FreshDatabase> => {
  const name = `test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = postgres(postgresTestUrl!, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database "${name}"`)
  const url = new URL(postgresTestUrl!)
  url.pathname = `/${name}`
  const client = postgres(url.toString(), { onnotice: () => {} })
  const db = drizzlePostgres({ client, schema })
  return {
    db: db as unknown as typeof DbType,
    migrate: (folder) => migratePostgres(db, { migrationsFolder: folder }),
    close: async () => {
      await client.end()
      await admin.unsafe(`drop database "${name}" with (force)`)
      await admin.end()
    },
  }
}

const databases = [
  { name: 'PGlite', skip: false, open: openPglite },
  { name: 'Postgres', skip: !postgresTestUrl, open: openPostgres },
]

const envIssuer = 'https://legacy.idp.test'

/** Only the settings a deployment on the previous release had: none of this project's own. */
const oldEnvSettings: Settings = createTestSettings({
  logLevel: 'ERROR',
  posthogHost: '',
  authMode: 'oidc',
  oidcIssuer: envIssuer,
  oidcClientId: fakeOidcClientId,
  oidcClientSecret: 'legacy-secret',
  powersyncUrl: 'http://localhost:8080',
  powersyncJwtSecret: 'upgrade-test-powersync-secret-of-32-chars',
  powersyncJwtKid: 'upgrade-test',
  // One secret, as in a deployment: Better Auth reads the env, and the settings carry the same value.
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
})

/** The value a client holds for a session: the raw token and its signature, as Better Auth issues it. */
const signed = (token: string) =>
  `${token}.${createHmac('sha256', oldEnvSettings.betterAuthSecret).update(token).digest('base64')}`

describe.each(databases)('upgrading an existing deployment on $name', ({ skip, open }) => {
  if (skip) {
    it.skip('needs TEST_POSTGRES_URL', () => {})
    return
  }

  let database: FreshDatabase
  let db: typeof DbType
  let auth: Auth
  let app: { handle: (request: Request) => Promise<Response> }
  let idps: FakeOidcIdps
  let settingsSpy: ReturnType<typeof spyOn>
  let oldMigrations: string

  /** What the previous release wrote, keyed by who each row stands for. */
  const old = {
    ssoUser: { id: crypto.randomUUID(), email: 'sso-user@corp.test', subject: crypto.randomUUID() },
    waitlistUser: { id: crypto.randomUUID(), email: 'waitlist-user@example.test' },
    earlyUser: { id: crypto.randomUUID(), email: 'early-user@example.test' },
    anonymousUser: { id: crypto.randomUUID(), email: 'anonymous@anonymous.test' },
    sessionToken: crypto.randomUUID().replaceAll('-', ''),
    deviceId: crypto.randomUUID(),
    // The plugin's default key: 64 characters, no prefix.
    apiKey: `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', ''),
  }

  const seedOldRelease = async () => {
    const insertUser = (row: { id: string; email: string }, { anonymous = false } = {}) =>
      db.execute(sql`
        insert into "user" (id, name, email, email_verified, is_anonymous)
        values (${row.id}, 'Existing', ${row.email}, ${!anonymous}, ${anonymous})
      `)
    await insertUser(old.ssoUser)
    await insertUser(old.waitlistUser)
    await insertUser(old.earlyUser)
    await insertUser(old.anonymousUser, { anonymous: true })
    await db.execute(sql`
      insert into account (id, account_id, provider_id, user_id, updated_at)
      values (${crypto.randomUUID()}, ${old.ssoUser.subject}, ${envSsoProviderId}, ${old.ssoUser.id}, now())
    `)
    await db.execute(sql`
      insert into waitlist (id, email, status) values (${crypto.randomUUID()}, ${old.waitlistUser.email}, 'approved')
    `)
    // A desktop or mobile client: its session is bound to its device.
    await db.execute(sql`
      insert into powersync.devices (id, user_id, trusted) values (${old.deviceId}, ${old.ssoUser.id}, true)
    `)
    await db.execute(sql`
      insert into session (id, token, user_id, device_id, expires_at, updated_at)
      values (${crypto.randomUUID()}, ${old.sessionToken}, ${old.ssoUser.id}, ${old.deviceId},
              now() + interval '1 day', now())
    `)
    await db.execute(sql`
      insert into apikey (id, key, reference_id, enabled, rate_limit_enabled, expires_at)
      values (${crypto.randomUUID()}, ${await defaultKeyHasher(old.apiKey)}, ${old.ssoUser.id}, true, false,
              now() + interval '1 day')
    `)
    // A provider row an earlier release let a signed-in user register.
    await db.execute(sql`
      insert into sso_provider (id, issuer, domain, provider_id, oidc_config)
      values (${crypto.randomUUID()}, 'https://stale.idp.test', 'stale.test', 'stale-idp',
              ${JSON.stringify({ issuer: 'https://stale.idp.test', clientId: 'stale', clientSecret: 'stale', pkce: true })})
    `)
  }

  /** What the new release does at boot, after its migrations. */
  const boot = async () => {
    await ensureImplicitOrganization(db)
    await ensureEnvSsoConnection(db, oldEnvSettings)
  }

  beforeAll(async () => {
    settingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(oldEnvSettings)
    database = await open()
    db = database.db
    oldMigrations = await migrationsUpTo(lastOldMigration)
    await database.migrate(oldMigrations)
    await seedOldRelease()

    await database.migrate(migrationsFolder)
    await boot()

    idps = await createFakeOidcIdps([envIssuer, 'https://stale.idp.test'])
    await idps.withIdps(async () => {
      auth = createAuth(db)
      const elysia = new Elysia({ prefix: '/v1' }).use(createBetterAuthPlugin(db).plugin)
      app = { handle: (request) => elysia.handle(request) }
    })
  }, 60_000)

  afterAll(async () => {
    settingsSpy.mockRestore()
    await rm(oldMigrations, { recursive: true, force: true })
    await database.close()
  })

  const getSession = (headers: Record<string, string>) =>
    app.handle(new Request('http://localhost/v1/api/auth/get-session', { headers }))

  const sessionUserOf = async (headers: Record<string, string>) => {
    const response = await getSession(headers)
    return ((await response.json()) as { user?: { id: string } } | null)?.user?.id
  }

  const sourcesOf = (userId: string) =>
    db
      .select({ kind: membershipSource.kind, status: membershipSource.status })
      .from(membershipSource)
      .innerJoin(orgMembership, eq(orgMembership.id, membershipSource.membershipId))
      .where(eq(orgMembership.userId, userId))

  it('turns the env SSO config into the connection `sso`', async () => {
    const [connection] = await db.select().from(identityConnection).where(eq(identityConnection.id, envSsoConnectionId))
    const [provider] = await db.select().from(ssoProvider).where(eq(ssoProvider.providerId, envSsoProviderId))

    expect(connection).toMatchObject({ status: 'active', matchClaim: 'sub', scimConnectionId: null })
    expect(connection.ssoProviderId).toBe(provider.id)
    expect(provider.issuer).toBe(envIssuer)
  })

  it('puts every existing user in the implicit org, with the source they most likely came by', async () => {
    expect(await sourcesOf(old.ssoUser.id)).toEqual([{ kind: 'sso', status: 'active' }])
    expect(await sourcesOf(old.waitlistUser.id)).toEqual([{ kind: 'waitlist', status: 'active' }])
    expect(await sourcesOf(old.earlyUser.id)).toEqual([{ kind: 'open', status: 'active' }])
    expect(await sourcesOf(old.anonymousUser.id)).toEqual([])
  })

  it('keeps existing sessions and API keys working: cookie, signed bearer and key', async () => {
    const cookie = { Cookie: `better-auth.session_token=${encodeURIComponent(signed(old.sessionToken))}` }
    const bearer = { Authorization: `Bearer ${signed(old.sessionToken)}` }

    expect(await sessionUserOf(cookie)).toBe(old.ssoUser.id)
    expect(await sessionUserOf(bearer)).toBe(old.ssoUser.id)
    expect(await sessionUserOf({ 'x-api-key': old.apiKey })).toBe(old.ssoUser.id)
  })

  it('gives the signed bearer a sync token, both through the session and on the bearer-only refresh path', async () => {
    const tokenRequest = () =>
      new Request('http://localhost/powersync/token', {
        headers: { Authorization: `Bearer ${signed(old.sessionToken)}`, 'x-device-id': old.deviceId },
      })
    // The refresh path runs when the session lookup finds nothing, and reads the session row itself.
    const refreshOnly = { ...auth, api: { ...auth.api, getSession: async () => null } } as unknown as Auth

    const viaSession = await createPowerSyncRoutes(auth, oldEnvSettings, db).handle(tokenRequest())
    const viaRefresh = await createPowerSyncRoutes(refreshOnly, oldEnvSettings, db).handle(tokenRequest())

    expect(viaSession.status).toBe(200)
    expect(viaRefresh.status).toBe(200)
    expect(await viaRefresh.json()).toMatchObject({ token: expect.any(String) })
  })

  it('signs an existing SSO user in to the same user, and an existing waitlist user by email code', async () => {
    const viaSso = await idps.signIn(app, {
      providerId: envSsoProviderId,
      issuer: envIssuer,
      subject: old.ssoUser.subject,
      email: old.ssoUser.email,
    })
    expect(await sessionUserOf({ Cookie: viaSso.cookie })).toBe(old.ssoUser.id)

    await auth.api.sendVerificationOTP({ body: { email: old.waitlistUser.email, type: 'sign-in' } })
    const viaCode = (await auth.api.signInEmailOTP({
      body: { email: old.waitlistUser.email, otp: testSignInOtp },
      headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, old.waitlistUser.email) }),
      asResponse: true,
    })) as Response
    expect(viaCode.status).toBe(200)
  })

  it('still keeps a new address with no approval out, and the stale provider row signs no one in', async () => {
    const email = `newcomer-${crypto.randomUUID()}@example.test`
    await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } }).catch(() => undefined)
    const viaCode = (await auth.api
      .signInEmailOTP({
        body: { email, otp: testSignInOtp },
        headers: new Headers({ [challengeTokenHeader]: await createTestChallenge(db, email) }),
        asResponse: true,
      })
      .catch((error: { statusCode?: number }) => new Response(null, { status: error.statusCode ?? 500 }))) as Response
    const viaStale = await idps.signIn(app, {
      providerId: 'stale-idp',
      issuer: 'https://stale.idp.test',
      subject: crypto.randomUUID(),
      email,
    })

    expect(viaCode.status).toBeGreaterThanOrEqual(400)
    expect(viaStale.cookie).toBe('')
    expect(await db.$count(user, eq(user.email, email))).toBe(0)
  })

  it('changes nothing on the next boot', async () => {
    const memberships = await db.$count(orgMembership)
    const events = await db.$count(auditEvent)

    await boot()

    expect(await db.$count(orgMembership)).toBe(memberships)
    expect(await db.$count(auditEvent)).toBe(events)
  })

  it('signs a user created by an old instance mid-deploy out once, then admits them at their next sign-in', async () => {
    // An instance still on the old release signs a new SSO user up after the new one created the org.
    const straggler = { id: crypto.randomUUID(), email: 'straggler@corp.test', subject: crypto.randomUUID() }
    const token = crypto.randomUUID().replaceAll('-', '')
    await db.execute(sql`
      insert into "user" (id, name, email, email_verified) values (${straggler.id}, 'Straggler', ${straggler.email}, true)
    `)
    await db.execute(sql`
      insert into account (id, account_id, provider_id, user_id, updated_at)
      values (${crypto.randomUUID()}, ${straggler.subject}, ${envSsoProviderId}, ${straggler.id}, now())
    `)
    await db.execute(sql`
      insert into session (id, token, user_id, expires_at, updated_at)
      values (${crypto.randomUUID()}, ${token}, ${straggler.id}, now() + interval '1 day', now())
    `)

    expect(await sessionUserOf({ Authorization: `Bearer ${signed(token)}` })).toBeUndefined()

    const again = await idps.signIn(app, {
      providerId: envSsoProviderId,
      issuer: envIssuer,
      subject: straggler.subject,
      email: straggler.email,
    })
    expect(await sessionUserOf({ Cookie: again.cookie })).toBe(straggler.id)
    expect(await sourcesOf(straggler.id)).toEqual([{ kind: 'sso', status: 'active' }])
  })
})
