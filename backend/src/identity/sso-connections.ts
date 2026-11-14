/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { db as DbType, QueryableDatabase } from '@/db/client'
import {
  identityConnection,
  type identityConnectionStatuses,
  membershipSource,
  orgDomain,
  ssoProvider,
} from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { computeDiscoveryUrl } from '@better-auth/sso'
import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type { AuthAdapter } from './access'
import { insertAuditEvent } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'

/**
 * The provider built from the `OIDC_*`/`SAML_*` env, and its connection. The id is kept from the
 * single-provider releases, so existing accounts and the callback URLs IdPs know keep working.
 */
export const envSsoProviderId = 'sso'
export const envSsoConnectionId = 'sso'

/** Whether the deployment signs in through SSO connections. */
export const isSsoAuthMode = (settings: Pick<Settings, 'authMode'>) =>
  settings.authMode === 'oidc' || settings.authMode === 'saml'

export type OidcConnectionConfig = {
  issuer: string
  clientId: string
  clientSecret: string
  discoveryEndpoint?: string
}

export type SamlConnectionConfig = {
  /** Names our service provider to the IdP. */
  entityId: string
  entryPoint: string
  cert: string
  idpIssuer: string
}

/**
 * The plugin's own `domain` routing is unused: sign-in always names a provider, and the login
 * screen finds it through `org_domain` claims (`discoverSsoConnections`).
 */
const noRoutingDomain = ''

type SsoProviderRow = Pick<typeof ssoProvider.$inferInsert, 'issuer' | 'oidcConfig' | 'samlConfig'>

/** The `sso_provider` fields the SSO plugin reads, in the shape its `/sso/register` writes. */
const oidcProviderRow = ({
  issuer,
  clientId,
  clientSecret,
  discoveryEndpoint,
}: OidcConnectionConfig): SsoProviderRow => ({
  issuer,
  oidcConfig: JSON.stringify({
    issuer,
    pkce: true,
    clientId,
    clientSecret,
    // Better Auth's helper strips a trailing slash from the issuer, as OIDC Discovery requires.
    discoveryEndpoint: discoveryEndpoint || computeDiscoveryUrl(issuer),
    scopes: ['openid', 'profile', 'email'],
  }),
  samlConfig: null,
})

const samlProviderRow = ({ entityId, entryPoint, cert, idpIssuer }: SamlConnectionConfig): SsoProviderRow => ({
  // `issuer` names our service provider; the IdP is identified by idpMetadata.entityID.
  issuer: entityId,
  oidcConfig: null,
  samlConfig: JSON.stringify({ issuer: entityId, entryPoint, cert, idpMetadata: { entityID: idpIssuer } }),
})

/**
 * The env-configured provider, or null outside SSO mode. Throws when SSO mode is on and its env
 * vars are incomplete, so a misconfigured deployment fails at startup.
 */
export const envSsoProvider = (settings: Settings): SsoProviderRow | null => {
  if (settings.authMode === 'oidc') {
    if (!settings.oidcIssuer || !settings.oidcClientId || !settings.oidcClientSecret) {
      throw new Error(
        'OIDC is enabled (AUTH_MODE=oidc) but one or more required env vars are missing: ' +
          'OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET. Set all three to configure OIDC authentication.',
      )
    }
    return oidcProviderRow({
      issuer: settings.oidcIssuer,
      clientId: settings.oidcClientId,
      clientSecret: settings.oidcClientSecret,
      discoveryEndpoint: settings.oidcDiscoveryUrl,
    })
  }
  if (settings.authMode === 'saml') {
    if (!settings.samlEntryPoint || !settings.samlCert || !settings.samlEntityId || !settings.samlIdpIssuer) {
      throw new Error(
        'SAML is enabled (AUTH_MODE=saml) but one or more required env vars are missing: ' +
          'SAML_ENTRY_POINT, SAML_CERT, SAML_ENTITY_ID, SAML_IDP_ISSUER. Set all four to configure SAML authentication.',
      )
    }
    return samlProviderRow({
      entityId: settings.samlEntityId,
      entryPoint: settings.samlEntryPoint,
      cert: settings.samlCert,
      idpIssuer: settings.samlIdpIssuer,
    })
  }
  return null
}

const parseConfig = (config: string | null | undefined): Record<string, unknown> =>
  config ? (JSON.parse(config) as Record<string, unknown>) : {}

/**
 * The provider fields an env change touched, by name (`oidcConfig.clientSecret`): an audit event
 * names what changed, never a value, so a rotated secret leaves no trace of itself.
 */
const changedProviderFields = (stored: SsoProviderRow, next: SsoProviderRow) => {
  const changed = stored.issuer === next.issuer ? [] : ['issuer']
  for (const field of ['oidcConfig', 'samlConfig'] as const) {
    const [before, after] = [parseConfig(stored[field]), parseConfig(next[field])]
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changed.push(`${field}.${key}`)
      }
    }
  }
  return changed
}

/**
 * Write the env provider and its connection. Runs at boot, after the implicit organization exists.
 * The env stays authoritative for this one row, so editing it (a rotated client secret) applies on
 * restart, audited as `connection.updated`; connections an admin created are never touched. The first run also attributes the `sso`
 * sources of members who signed in before connections existed to this connection.
 */
export const ensureEnvSsoConnection = async (database: typeof DbType, settings: Settings) => {
  const provider = envSsoProvider(settings)
  if (!provider) {
    return
  }
  const orgId = getCurrentOrganizationId()

  await database.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: ssoProvider.id,
        userId: ssoProvider.userId,
        issuer: ssoProvider.issuer,
        oidcConfig: ssoProvider.oidcConfig,
        samlConfig: ssoProvider.samlConfig,
      })
      .from(ssoProvider)
      .where(eq(ssoProvider.providerId, envSsoProviderId))
    if (existing.length > 1) {
      throw new Error(`Several sso_provider rows use the reserved provider id "${envSsoProviderId}"`)
    }
    const [current] = existing
    if (current?.userId) {
      console.warn(`The env SSO config takes over an sso_provider row "${envSsoProviderId}" a user registered`)
    }
    if (!current) {
      // Replicas booting the same upgrade race to insert this row; the loser updates the winner's.
      await tx
        .insert(ssoProvider)
        .values({ id: envSsoProviderId, providerId: envSsoProviderId, domain: noRoutingDomain, ...provider })
        .onConflictDoNothing({ target: ssoProvider.id })
    }
    const [{ id: ssoProviderId }] = await tx
      .update(ssoProvider)
      .set({ ...provider, userId: null })
      .where(eq(ssoProvider.providerId, envSsoProviderId))
      .returning()

    // Only the id: a clash on the name must fail loudly, not leave the env provider without a connection.
    const created = await tx
      .insert(identityConnection)
      .values({ id: envSsoConnectionId, orgId, name: 'SSO', ssoProviderId })
      .onConflictDoNothing({ target: identityConnection.id })
      .returning()
    if (created.length === 0) {
      // The provider row may have been recreated under a new id since.
      await tx.update(identityConnection).set({ ssoProviderId }).where(eq(identityConnection.id, envSsoConnectionId))
      const changedFields = current ? changedProviderFields(current, provider) : []
      if (changedFields.length > 0) {
        await insertAuditEvent(tx, {
          action: 'connection.updated',
          outcome: 'success',
          actor: { type: 'system' },
          target: { type: 'identity_connection', id: envSsoConnectionId },
          connectionId: envSsoConnectionId,
          metadata: { source: 'env', changedFields },
        })
      }
      return
    }
    await tx
      .update(membershipSource)
      .set({ identityConnectionId: envSsoConnectionId })
      .where(
        and(
          eq(membershipSource.orgId, orgId),
          eq(membershipSource.kind, 'sso'),
          isNull(membershipSource.identityConnectionId),
        ),
      )
    await insertAuditEvent(tx, {
      action: 'connection.created',
      outcome: 'success',
      actor: { type: 'system' },
      target: { type: 'identity_connection', id: envSsoConnectionId },
      connectionId: envSsoConnectionId,
      metadata: { source: 'env' },
    })
  })
}

export type CreateSsoConnectionInput = {
  name: string
  /** Names the connection in its callback URLs (`/sso/callback/<providerId>`). */
  providerId: string
  protocol: { oidc: OidcConnectionConfig } | { saml: SamlConnectionConfig }
  /** `oid` for Entra, `sub` for Okta and Keycloak, or a SAML attribute name. */
  matchClaim?: string
  /** Attach the SSO side to this existing connection (one with only a SCIM side) instead of creating one. */
  identityConnectionId?: string
  createdBy?: string | null
}

/** What a connection's provider id may be: it appears in callback URLs. */
export const ssoProviderIdPattern = '^[a-z0-9][a-z0-9-]{0,62}$'

/**
 * Create an SSO connection. This and the env seed are the only writers: SSO providers are never
 * registered through Better Auth's `/sso/register`, which the auth guard refuses to every caller.
 * Returns the connection id.
 */
export const createSsoConnection = async (
  database: typeof DbType,
  { name, providerId, protocol, matchClaim, identityConnectionId, createdBy = null }: CreateSsoConnectionInput,
) => {
  if (!new RegExp(ssoProviderIdPattern).test(providerId) || providerId === envSsoProviderId) {
    throw new Error(`Invalid SSO provider id "${providerId}"`)
  }
  const orgId = getCurrentOrganizationId()
  const row = 'oidc' in protocol ? oidcProviderRow(protocol.oidc) : samlProviderRow(protocol.saml)

  return database.transaction(async (tx) => {
    const taken = await tx.$count(ssoProvider, eq(ssoProvider.providerId, providerId))
    if (taken > 0) {
      throw new Error(`SSO provider id "${providerId}" is already in use`)
    }
    const [{ id: ssoProviderId }] = await tx
      .insert(ssoProvider)
      .values({ id: crypto.randomUUID(), providerId, domain: noRoutingDomain, ...row })
      .returning()
    const connectionId = identityConnectionId
      ? await attachSsoSide(tx, identityConnectionId, { ssoProviderId, matchClaim })
      : await insertConnection(tx, { orgId, name, ssoProviderId, matchClaim, createdBy })
    await insertAuditEvent(tx, {
      action: 'connection.created',
      outcome: 'success',
      actor: createdBy ? { type: 'user', id: createdBy } : { type: 'system' },
      target: { type: 'identity_connection', id: connectionId },
      connectionId,
      metadata: { side: 'sso', providerId },
    })
    return connectionId
  })
}

const insertConnection = async (
  tx: QueryableDatabase,
  values: Pick<typeof identityConnection.$inferInsert, 'orgId' | 'name' | 'ssoProviderId' | 'matchClaim' | 'createdBy'>,
) => {
  const [{ id }] = await tx
    .insert(identityConnection)
    .values({ id: crypto.randomUUID(), ...values })
    .returning()
  return id
}

const attachSsoSide = async (
  tx: QueryableDatabase,
  identityConnectionId: string,
  values: Pick<typeof identityConnection.$inferInsert, 'ssoProviderId' | 'matchClaim'>,
) => {
  const attached = await tx
    .update(identityConnection)
    .set(values)
    .where(
      and(
        eq(identityConnection.id, identityConnectionId),
        eq(identityConnection.orgId, getCurrentOrganizationId()),
        isNull(identityConnection.ssoProviderId),
        ne(identityConnection.status, 'retired'),
      ),
    )
    .returning()
  if (attached.length === 0) {
    throw new Error(`Connection "${identityConnectionId}" cannot take an SSO side`)
  }
  return identityConnectionId
}

export type SsoConnection = {
  id: string
  scimConnectionId: string | null
  /** The claim whose value is the subject's SCIM `externalId`. */
  matchClaim: string
  status: (typeof identityConnectionStatuses)[number]
}

/**
 * The connection whose SSO side is the provider `providerId`, or null when the provider is not one
 * of ours (a row an older release let a user register) or its connection is retired.
 */
export const findSsoConnection = async (adapter: AuthAdapter, providerId: string) => {
  const provider = await adapter.findOne<{ id: string }>({
    model: 'ssoProvider',
    where: [{ field: 'providerId', value: providerId }],
  })
  if (!provider) {
    return null
  }
  return adapter.findOne<SsoConnection>({
    model: 'identityConnection',
    where: [
      { field: 'orgId', value: getCurrentOrganizationId() },
      { field: 'ssoProviderId', value: provider.id },
      { field: 'status', value: 'retired', operator: 'ne' },
    ],
  })
}

/**
 * "Require a SCIM record before first login": on while the connection has an active SCIM side. Once
 * its SCIM side starts retiring, the access check stops counting its SCIM sources, so the
 * connection admits at sign-in like one without SCIM.
 */
export const requiresScimRecord = (connection: Pick<SsoConnection, 'scimConnectionId' | 'status'>) =>
  connection.scimConnectionId !== null && connection.status === 'active'

export type SsoConnectionOption = { providerId: string; name: string }

/**
 * The connections the login screen offers. The only connection whatever the email; otherwise the
 * one that claims the email's domain; otherwise all of them. Decided by the domain alone, never by
 * the address, so the answer reveals nothing about who is a member.
 */
export const discoverSsoConnections = async (
  database: QueryableDatabase,
  email?: string,
): Promise<SsoConnectionOption[]> => {
  const orgId = getCurrentOrganizationId()
  const connections = await database
    .select({ id: identityConnection.id, providerId: ssoProvider.providerId, name: identityConnection.name })
    .from(identityConnection)
    .innerJoin(ssoProvider, eq(ssoProvider.id, identityConnection.ssoProviderId))
    .where(and(eq(identityConnection.orgId, orgId), ne(identityConnection.status, 'retired')))
    .orderBy(asc(identityConnection.name))
  const options = (rows: typeof connections) => rows.map(({ providerId, name }) => ({ providerId, name }))

  const domain = email?.includes('@') ? normalizeEmail(email).split('@').at(-1) : undefined
  if (connections.length <= 1 || !domain) {
    return options(connections)
  }
  const [claim] = await database
    .select({ connectionId: orgDomain.claimedByConnectionId })
    .from(orgDomain)
    .where(and(eq(orgDomain.orgId, orgId), eq(orgDomain.domain, domain)))
  const claimed = connections.find((connection) => connection.id === claim?.connectionId)
  return options(claimed ? [claimed] : connections)
}
