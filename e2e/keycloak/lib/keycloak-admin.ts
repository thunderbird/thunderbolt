/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { keycloakUrl, seedPassword } from './config'

type AdminToken = { value: string; expiresAt: number }
let token: AdminToken | null = null

/** A master-realm admin token from the stack's bootstrap admin, renewed shortly before it expires. */
const adminToken = async () => {
  if (token && token.expiresAt > Date.now() + 5_000) {
    return token.value
  }
  const response = await fetch(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'admin-cli', username: 'admin', password: 'admin', grant_type: 'password' }),
  })
  if (!response.ok) {
    throw new Error(`Keycloak admin token: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { access_token: string; expires_in: number }
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  return token.value
}

/** Call Keycloak's admin REST API for `realm`. Throws on any non-2xx answer. */
const call = async <T = unknown>(realm: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${keycloakUrl}/admin/realms/${realm}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await adminToken()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Keycloak ${method} ${realm}${path}: ${response.status} ${await response.text()}`)
  }
  const text = await response.text()
  return { location: response.headers.get('location'), body: (text ? JSON.parse(text) : null) as T }
}

const idFromLocation = (location: string | null) => location!.slice(location!.lastIndexOf('/') + 1)

export type KeycloakUser = {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled: boolean
}

export type NewUser = { username: string; email: string; firstName?: string; lastName?: string; id?: string }

const userRepresentation = ({ firstName = 'Kim', lastName = 'Keycloak', ...user }: NewUser) => ({
  ...user,
  firstName,
  lastName,
  enabled: true,
  emailVerified: true,
  credentials: [{ type: 'password', value: seedPassword, temporary: false }],
})

/** Keycloak's admin REST API for one realm: what an operator does in the admin console. */
export const keycloakRealm = (realm: string) => ({
  /** Create a user, as an admin does: the extension provisions it from the admin event. Returns its id. */
  createUser: async (user: NewUser) =>
    idFromLocation((await call(realm, 'POST', '/users', userRepresentation(user))).location),
  /**
   * Import users without admin events, so the extension sees them only at the next full sync.
   * Keeps a given `id`, which a plain create can't: how the suite reprovisions the same Keycloak user.
   */
  importUsers: (users: NewUser[]) =>
    call(realm, 'POST', '/partialImport', { ifResourceExists: 'FAIL', users: users.map(userRepresentation) }),
  getUser: async (id: string) => (await call<KeycloakUser>(realm, 'GET', `/users/${id}`)).body,
  findUser: async (username: string) =>
    (await call<KeycloakUser[]>(realm, 'GET', `/users?exact=true&username=${encodeURIComponent(username)}`)).body[0],
  updateUser: async (id: string, changes: Partial<KeycloakUser>) => {
    const current = (await call<KeycloakUser>(realm, 'GET', `/users/${id}`)).body
    await call(realm, 'PUT', `/users/${id}`, { ...current, ...changes })
  },
  deleteUser: (id: string) => call(realm, 'DELETE', `/users/${id}`),

  createGroup: async (name: string) => idFromLocation((await call(realm, 'POST', '/groups', { name })).location),
  findGroup: async (name: string) =>
    (await call<{ id: string; name: string }[]>(realm, 'GET', `/groups?exact=true&search=${encodeURIComponent(name)}`))
      .body[0],
  renameGroup: (id: string, name: string) => call(realm, 'PUT', `/groups/${id}`, { name }),
  deleteGroup: (id: string) => call(realm, 'DELETE', `/groups/${id}`),
  addToGroup: (userId: string, groupId: string) => call(realm, 'PUT', `/users/${userId}/groups/${groupId}`),
  removeFromGroup: (userId: string, groupId: string) => call(realm, 'DELETE', `/users/${userId}/groups/${groupId}`),

  /** The realm's User Federation components of the extension: one per SCIM target. */
  scimTargets: async () =>
    (
      await call<{ id: string; name: string; config: Record<string, string[]> }[]>(
        realm,
        'GET',
        '/components?type=org.keycloak.storage.UserStorageProvider&name=thunderbolt',
      )
    ).body,
  /** Add the extension's SCIM target, one per Thunderbolt SCIM connection. Returns its id. */
  createScimTarget: async (config: Record<string, string>) => {
    const realmId = (await call<{ id: string }>(realm, 'GET', '')).body.id
    const created = await call(realm, 'POST', '/components', {
      name: 'thunderbolt',
      providerId: 'keycloak-scim-outbound',
      providerType: 'org.keycloak.storage.UserStorageProvider',
      parentId: realmId,
      config: Object.fromEntries(Object.entries(config).map(([key, value]) => [key, [value]])),
    })
    return idFromLocation(created.location)
  },
  updateScimTarget: async (id: string, config: Record<string, string>) => {
    const current = (await call<{ config: Record<string, string[]> }>(realm, 'GET', `/components/${id}`)).body
    await call(realm, 'PUT', `/components/${id}`, {
      ...current,
      config: {
        ...current.config,
        ...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, [value]])),
      },
    })
  },
  /** "Synchronize all users" in the console. Returns the extension's counts. */
  syncAllUsers: async (targetId: string) =>
    (
      await call<{ added: number; updated: number; removed: number; failed: number }>(
        realm,
        'POST',
        `/user-storage/${targetId}/sync?action=triggerFullSync`,
      )
    ).body,

  /** The realm's SAML signing certificate, base64 DER, from its IdP metadata. */
  samlSigningCert: async () => {
    const descriptor = await (await fetch(`${keycloakUrl}/realms/${realm}/protocol/saml/descriptor`)).text()
    const cert = descriptor.match(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/)?.[1]
    if (!cert) {
      throw new Error(`No signing certificate in the ${realm} SAML descriptor`)
    }
    return cert
  },
})

export type KeycloakRealm = ReturnType<typeof keycloakRealm>
