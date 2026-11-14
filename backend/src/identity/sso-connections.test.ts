/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { identityConnection, membershipSource, orgDomain, orgMembership, ssoProvider, user } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from './current-organization'
import {
  createSsoConnection,
  discoverSsoConnections,
  ensureEnvSsoConnection,
  envSsoConnectionId,
  envSsoProviderId,
  requiresScimRecord,
} from './sso-connections'

const oidcSettings = createTestSettings({
  authMode: 'oidc',
  oidcIssuer: 'https://entra.test',
  oidcClientId: 'thunderbolt',
  oidcClientSecret: 'first-secret',
})

const samlSettings = createTestSettings({
  authMode: 'saml',
  samlEntryPoint: 'https://idp.test/saml/sso',
  samlEntityId: 'thunderbolt-sp',
  samlIdpIssuer: 'https://idp.test',
  samlCert: 'cert',
})

const oidcProtocol = (issuer: string) => ({ oidc: { issuer, clientId: 'thunderbolt', clientSecret: 'secret' } })

describe('SSO connections', () => {
  const orgId = getCurrentOrganizationId()
  let db: typeof DbType
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    // The shared database may hold the env connection from another suite; start without one.
    await db.delete(membershipSource).where(eq(membershipSource.identityConnectionId, envSsoConnectionId))
    await db.delete(identityConnection)
    await db.delete(ssoProvider)
  })

  afterEach(async () => {
    await cleanup()
  })

  const envProvider = async () => {
    const [row] = await db.select().from(ssoProvider).where(eq(ssoProvider.providerId, envSsoProviderId))
    return row
  }

  describe('ensureEnvSsoConnection', () => {
    it('writes nothing outside SSO mode', async () => {
      await ensureEnvSsoConnection(db, createTestSettings({ authMode: 'consumer' }))

      expect(await db.select().from(ssoProvider)).toEqual([])
      expect(await db.select().from(identityConnection)).toEqual([])
    })

    it('writes the env OIDC provider and its connection, and is a no-op on the next boot', async () => {
      await ensureEnvSsoConnection(db, oidcSettings)
      await ensureEnvSsoConnection(db, oidcSettings)

      const provider = await envProvider()
      expect(provider.issuer).toBe('https://entra.test')
      expect(JSON.parse(provider.oidcConfig!)).toMatchObject({ clientId: 'thunderbolt', clientSecret: 'first-secret' })
      expect(await db.select().from(identityConnection)).toEqual([
        expect.objectContaining({ id: envSsoConnectionId, ssoProviderId: provider.id, scimConnectionId: null }),
      ])
    })

    it('applies an env change, such as a rotated client secret, at the next boot', async () => {
      await ensureEnvSsoConnection(db, oidcSettings)
      await ensureEnvSsoConnection(db, { ...oidcSettings, oidcClientSecret: 'rotated-secret' })

      expect(JSON.parse((await envProvider()).oidcConfig!).clientSecret).toBe('rotated-secret')
    })

    it('writes the env SAML provider', async () => {
      await ensureEnvSsoConnection(db, samlSettings)

      const provider = await envProvider()
      expect(provider.issuer).toBe('thunderbolt-sp')
      expect(JSON.parse(provider.samlConfig!)).toMatchObject({
        entryPoint: 'https://idp.test/saml/sso',
        idpMetadata: { entityID: 'https://idp.test' },
      })
    })

    it('never touches a connection an admin created', async () => {
      const connectionId = await createSsoConnection(db, {
        name: 'Keycloak',
        providerId: 'keycloak',
        protocol: oidcProtocol('https://keycloak.test'),
      })
      const before = await db.select().from(ssoProvider).where(eq(ssoProvider.providerId, 'keycloak'))

      await ensureEnvSsoConnection(db, { ...oidcSettings, oidcClientSecret: 'rotated-secret' })

      expect(await db.select().from(ssoProvider).where(eq(ssoProvider.providerId, 'keycloak'))).toEqual(before)
      const [connection] = await db.select().from(identityConnection).where(eq(identityConnection.id, connectionId))
      expect(connection.name).toBe('Keycloak')
    })

    it('attributes sso sources from before connections to the env connection', async () => {
      const userId = crypto.randomUUID()
      await db.insert(user).values({ id: userId, name: 'Old', email: `old-${userId}@example.com` })
      const [membership] = await db.insert(orgMembership).values({ id: crypto.randomUUID(), orgId, userId }).returning()
      await db
        .insert(membershipSource)
        .values({ id: crypto.randomUUID(), orgId, membershipId: membership.id, kind: 'sso' })

      await ensureEnvSsoConnection(db, oidcSettings)

      const [source] = await db.select().from(membershipSource).where(eq(membershipSource.membershipId, membership.id))
      expect(source.identityConnectionId).toBe(envSsoConnectionId)
    })

    it('takes over a provider row a user registered under the reserved id', async () => {
      const ownerId = crypto.randomUUID()
      await db.insert(user).values({ id: ownerId, name: 'Owner', email: `owner-${ownerId}@example.com` })
      await db.insert(ssoProvider).values({
        id: crypto.randomUUID(),
        providerId: envSsoProviderId,
        issuer: 'https://attacker.test',
        domain: 'attacker.test',
        userId: ownerId,
      })

      await ensureEnvSsoConnection(db, oidcSettings)

      const provider = await envProvider()
      expect(provider).toMatchObject({ issuer: 'https://entra.test', userId: null })
    })

    it('survives replicas booting the upgrade at the same time', async () => {
      await Promise.all([ensureEnvSsoConnection(db, oidcSettings), ensureEnvSsoConnection(db, oidcSettings)])

      expect(await db.select().from(ssoProvider)).toHaveLength(1)
      expect(await db.select().from(identityConnection)).toEqual([
        expect.objectContaining({ id: envSsoConnectionId, ssoProviderId: envSsoProviderId }),
      ])
    })

    it('updates the provider row another replica inserted first', async () => {
      await db.insert(ssoProvider).values({
        id: envSsoProviderId,
        providerId: envSsoProviderId,
        issuer: 'https://stale.test',
        domain: '',
      })

      await ensureEnvSsoConnection(db, oidcSettings)

      expect((await envProvider()).issuer).toBe('https://entra.test')
    })

    it('refuses to boot when another connection already holds the env connection name', async () => {
      await db.insert(identityConnection).values({ id: crypto.randomUUID(), orgId, name: 'sso' })

      await expect(ensureEnvSsoConnection(db, oidcSettings)).rejects.toThrow()
    })

    it('throws when SSO mode is on and its env is incomplete', async () => {
      await expect(ensureEnvSsoConnection(db, { ...oidcSettings, oidcClientSecret: '' })).rejects.toThrow(
        'OIDC_CLIENT_SECRET',
      )
    })
  })

  describe('createSsoConnection', () => {
    it('refuses the reserved env id, a malformed id and an id already in use', async () => {
      const create = (providerId: string) =>
        createSsoConnection(db, { name: providerId, providerId, protocol: oidcProtocol('https://idp.test') })

      await expect(create(envSsoProviderId)).rejects.toThrow()
      await expect(create('Not An Id')).rejects.toThrow()
      await create('okta')
      await expect(create('okta')).rejects.toThrow()
    })

    it('attaches the SSO side, with its match claim, to an existing SCIM-only connection instead of creating one', async () => {
      const [scimOnly] = await db
        .insert(identityConnection)
        .values({ id: crypto.randomUUID(), orgId, name: 'Entra', scimConnectionId: 'scim-entra' })
        .returning()

      const connectionId = await createSsoConnection(db, {
        name: 'Entra',
        providerId: 'entra',
        protocol: oidcProtocol('https://entra.test'),
        matchClaim: 'oid',
        identityConnectionId: scimOnly.id,
      })

      expect(connectionId).toBe(scimOnly.id)
      expect(await db.select().from(identityConnection)).toEqual([
        expect.objectContaining({
          id: scimOnly.id,
          scimConnectionId: 'scim-entra',
          ssoProviderId: expect.any(String),
          matchClaim: 'oid',
        }),
      ])
      await expect(
        createSsoConnection(db, {
          name: 'Entra again',
          providerId: 'entra-again',
          protocol: oidcProtocol('https://entra.test'),
          identityConnectionId: scimOnly.id,
        }),
      ).rejects.toThrow()
    })
  })

  describe('requiresScimRecord', () => {
    it('is on only while the connection has an active SCIM side', () => {
      expect(requiresScimRecord({ scimConnectionId: null, status: 'active' })).toBe(false)
      expect(requiresScimRecord({ scimConnectionId: 'scim', status: 'active' })).toBe(true)
      expect(requiresScimRecord({ scimConnectionId: 'scim', status: 'scim_retiring' })).toBe(false)
      expect(requiresScimRecord({ scimConnectionId: 'scim', status: 'scim_retired' })).toBe(false)
    })
  })

  describe('discoverSsoConnections', () => {
    const claim = (domain: string, connectionId: string) =>
      db.insert(orgDomain).values({
        id: crypto.randomUUID(),
        orgId,
        domain,
        verificationToken: crypto.randomUUID(),
        claimedByConnectionId: connectionId,
      })

    it('offers the only connection whatever the email', async () => {
      await ensureEnvSsoConnection(db, oidcSettings)

      expect(await discoverSsoConnections(db)).toEqual([{ providerId: envSsoProviderId, name: 'SSO' }])
      expect(await discoverSsoConnections(db, 'anyone@anywhere.test')).toEqual([
        { providerId: envSsoProviderId, name: 'SSO' },
      ])
    })

    it('routes a claimed domain to its connection and offers every connection otherwise', async () => {
      await ensureEnvSsoConnection(db, oidcSettings)
      const keycloak = await createSsoConnection(db, {
        name: 'Keycloak',
        providerId: 'keycloak',
        protocol: oidcProtocol('https://keycloak.test'),
      })
      await claim('a.test', envSsoConnectionId)
      await claim('b.test', keycloak)
      const all = [
        { providerId: 'keycloak', name: 'Keycloak' },
        { providerId: envSsoProviderId, name: 'SSO' },
      ]

      expect(await discoverSsoConnections(db, 'Person@A.test')).toEqual([{ providerId: envSsoProviderId, name: 'SSO' }])
      expect(await discoverSsoConnections(db, 'person@b.test')).toEqual([{ providerId: 'keycloak', name: 'Keycloak' }])
      expect(await discoverSsoConnections(db, 'contractor@gmail.test')).toEqual(all)
      expect(await discoverSsoConnections(db)).toEqual(all)
    })

    it('leaves out retired connections and connections with no SSO side', async () => {
      await ensureEnvSsoConnection(db, oidcSettings)
      const retired = await createSsoConnection(db, {
        name: 'Old IdP',
        providerId: 'old-idp',
        protocol: oidcProtocol('https://old.test'),
      })
      await db.update(identityConnection).set({ status: 'retired' }).where(eq(identityConnection.id, retired))
      await db
        .insert(identityConnection)
        .values({ id: crypto.randomUUID(), orgId, name: 'SCIM only', scimConnectionId: 'scim-only' })

      expect(await discoverSsoConnections(db, 'person@old.test')).toEqual([
        { providerId: envSsoProviderId, name: 'SSO' },
      ])
    })
  })
})
