/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Connect the local Keycloak realms to the local backend, as an admin would: one SSO connection
 * and one SCIM connection per realm, the realm's domain verified (and claimed where the realm
 * claims it), the extension's SCIM target in each realm, an initial full sync, and the admin-group
 * role mapping. Safe to run again: it creates only what is missing.
 *
 *   bun e2e/keycloak/setup.ts
 *
 * See docs/internals/development/keycloak-validation.md.
 */

import { join } from 'node:path'
import { adminEmail, backendUrl, keycloakUrl, type Realm, realms, scimBaseUrlFromKeycloak } from './lib/config'
import { keycloakRealm } from './lib/keycloak-admin'
import { readStateIfAny, type RealmState, type StackState, writeState } from './lib/state'
import { asCaller, bearer, closeDatabase, scimUserOf, sessionUser, signInByEmailCode } from './lib/thunderbolt'
import { waitFor } from './lib/wait-for'

type Connection = {
  id: string
  sso: { providerId: string } | null
  scim: { scimConnectionId: string } | null
  claimedDomains: string[]
}
type Domain = { id: string; domain: string; verifiedAt: string | null; claimedBy: { id: string } | null }

const healthy = async (url: string) => {
  try {
    return (await fetch(url)).ok || null
  } catch {
    return null
  }
}

/** The admin's bearer token: the saved one while it still works, else a new email-code sign-in. */
const adminSession = async (previous: StackState | null) => {
  if (previous && (await sessionUser(bearer(previous.adminBearer)))) {
    return { bearer: previous.adminBearer, userId: previous.adminUserId }
  }
  const { status, bearer: token } = await signInByEmailCode(adminEmail)
  if (status !== 200 || !token) {
    throw new Error(`Bootstrap admin sign-in failed with ${status}: is BOOTSTRAP_ADMIN_EMAILS=${adminEmail} set?`)
  }
  return { bearer: token, userId: (await sessionUser(bearer(token)))! }
}

const ssoProtocol = async (realm: Realm) => {
  const issuer = `${keycloakUrl}/realms/${realm.name}`
  if (realm.protocol === 'oidc') {
    return { oidc: { issuer, clientId: 'thunderbolt-app', clientSecret: `${realm.name}-secret` } }
  }
  return {
    saml: {
      entityId: `thunderbolt-${realm.name}`,
      entryPoint: `${issuer}/protocol/saml`,
      cert: await keycloakRealm(realm.name).samlSigningCert(),
      idpIssuer: issuer,
    },
  }
}

/** Mark a domain verified with the dev-only script: `.test` domains can't hold a TXT record. */
const verifyDomainLocally = async (domain: string, actorId: string) => {
  const backend = join(import.meta.dir, '..', '..', 'backend')
  const run = Bun.spawnSync(
    ['bun', '--env-file=../e2e/keycloak/backend.env', 'scripts/verify-org-domain-dev.ts', domain, actorId],
    { cwd: backend, stdout: 'inherit', stderr: 'inherit' },
  )
  if (run.exitCode !== 0) {
    throw new Error(`Verifying ${domain} failed`)
  }
}

const setUpRealm = async (
  realm: Realm,
  admin: ReturnType<typeof asCaller>,
  adminUserId: string,
  previous: RealmState | undefined,
): Promise<RealmState> => {
  const connections = (await admin.get<{ items: Connection[] }>('/admin/connections')).body.items
  const existing = connections.find((connection) => connection.sso?.providerId === realm.name)
  const identityConnectionId =
    existing?.id ??
    (
      await admin.post<{ id: string }>('/admin/connections/sso', {
        name: `Keycloak ${realm.name}`,
        providerId: realm.name,
        protocol: await ssoProtocol(realm),
        matchClaim: realm.matchClaim,
      })
    ).body.id

  const scimToken = await (async () => {
    if (!existing?.scim) {
      return (await admin.post<{ token: string }>('/admin/connections/scim', { identityConnectionId })).body.token
    }
    if (previous?.scimToken) {
      return previous.scimToken
    }
    // The token is shown only once: issue another, which works beside the lost one.
    return (await admin.post<{ token: string }>(`/admin/connections/${identityConnectionId}/scim/credentials`)).body
      .token
  })()

  const domains = (await admin.get<{ items: Domain[] }>('/admin/domains')).body.items
  const domain =
    domains.find((row) => row.domain === realm.domain) ??
    (await admin.post<Domain>('/admin/domains', { domain: realm.domain })).body
  if (!domain.verifiedAt) {
    await verifyDomainLocally(realm.domain, adminUserId)
  }
  if (realm.claimsDomain && !domain.claimedBy) {
    const claimed = await admin.put(`/admin/domains/${domain.id}/claim`, { identityConnectionId })
    if (claimed.status !== 200) {
      throw new Error(`Claiming ${realm.domain}: ${claimed.status} ${JSON.stringify(claimed.body)}`)
    }
  }

  const keycloak = keycloakRealm(realm.name)
  const targetConfig = {
    baseUrl: scimBaseUrlFromKeycloak,
    token: scimToken,
    userNameStrategy: realm.userNameStrategy,
    deprovisionAction: 'deactivate',
    lookupMode: 'externalId',
    adoptExisting: 'false',
    discoverSchema: 'true',
    syncEmail: 'true',
    syncGroups: 'true',
    allowLoopbackHttp: 'true',
    enabled: 'true',
  }
  const [target] = await keycloak.scimTargets()
  const targetId = target?.id ?? (await keycloak.createScimTarget(targetConfig))
  if (target) {
    await keycloak.updateScimTarget(target.id, targetConfig)
  }
  // eslint-disable-next-line no-console -- Progress of a command-line script.
  console.log(`${realm.name}: full sync`, await keycloak.syncAllUsers(targetId))
  return { identityConnectionId, scimToken, targetId }
}

/** Map the realm's admin group to the admin role by its SCIM group id, once the extension sent it. */
const mapAdminGroup = async (realm: Realm, admin: ReturnType<typeof asCaller>, state: RealmState) => {
  if (!realm.adminGroup) {
    return
  }
  const keycloakGroup = await keycloakRealm(realm.name).findGroup(realm.adminGroup)
  const scimGroup = await waitFor(`the ${realm.adminGroup} SCIM group`, async () => {
    const page = await admin.get<{ items: { id: string; externalId: string | null }[] }>(
      `/admin/connections/${state.identityConnectionId}/scim-groups?limit=100`,
    )
    return page.body.items.find((group) => group.externalId === keycloakGroup.id)
  })
  const mappings = await admin.get<{ items: { target: { scimGroupId?: string } }[] }>(
    `/admin/role-mappings?connectionId=${state.identityConnectionId}`,
  )
  if (!mappings.body.items.some((mapping) => mapping.target.scimGroupId === scimGroup.id)) {
    await admin.post('/admin/role-mappings', {
      identityConnectionId: state.identityConnectionId,
      scimGroupId: scimGroup.id,
      role: 'admin',
    })
  }
}

await waitFor('Keycloak', () => healthy(`${keycloakUrl}/realms/master`), { timeoutMs: 180_000, intervalMs: 2_000 })
await waitFor('the backend', () => healthy(`${backendUrl}/v1/health`), { timeoutMs: 60_000, intervalMs: 1_000 })

const previous = readStateIfAny()
const session = await adminSession(previous)
const admin = asCaller(bearer(session.bearer))
const realmStates = {} as StackState['realms']
for (const realm of realms) {
  realmStates[realm.name] = await setUpRealm(realm, admin, session.userId, previous?.realms[realm.name])
}
for (const realm of realms) {
  const seeded = await keycloakRealm(realm.name).findUser(realm.name === 'initech' ? 'ivan' : 'alice')
  await waitFor(`${realm.name}'s seeded users`, () =>
    scimUserOf(realmStates[realm.name].identityConnectionId, seeded.id),
  )
  await mapAdminGroup(realm, admin, realmStates[realm.name])
}
writeState({ adminUserId: session.userId, adminBearer: session.bearer, realms: realmStates })
await closeDatabase()
// eslint-disable-next-line no-console -- Progress of a command-line script.
console.log('Keycloak validation stack is set up')
