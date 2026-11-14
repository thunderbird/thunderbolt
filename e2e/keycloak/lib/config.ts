/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Where the local stack listens: e2e/keycloak/docker-compose.yml and backend.env. */
export const keycloakUrl = 'http://localhost:8280'
export const backendUrl = 'http://localhost:8000'
export const appOrigin = 'http://localhost:1420'
export const databaseUrl = 'postgresql://postgres:postgres@localhost:5435/thunderbolt'
/** Keycloak's own database, which holds the extension's queue. */
export const keycloakDatabaseUrl = 'postgresql://postgres:postgres@localhost:5435/keycloak'
/** The backend as the extension inside the Keycloak container reaches it (see `scim-loopback`). */
export const scimBaseUrlFromKeycloak = 'http://127.0.0.1:18000/v1/api/auth/scim/v2'

/** The bootstrap admin of backend.env, who no IdP manages: also the break-glass admin. */
export const adminEmail = 'admin@thunderbolt.test'

/** Every seeded Keycloak user's password. */
export const seedPassword = 'password'

export type Realm = {
  /** The Keycloak realm, and the Thunderbolt SSO provider id. */
  name: 'acme' | 'globex' | 'initech'
  protocol: 'oidc' | 'saml'
  /** The email domain the realm's users have, verified in Thunderbolt. */
  domain: string
  /** Whether the realm's connection claims its domain. */
  claimsDomain: boolean
  matchClaim: string
  /** How the extension names a SCIM user. */
  userNameStrategy: 'username' | 'email'
  /** A seeded group the suite maps to the admin role, by its SCIM group id. */
  adminGroup?: string
}

export const realms: Realm[] = [
  {
    name: 'acme',
    protocol: 'oidc',
    domain: 'acme.test',
    claimsDomain: true,
    matchClaim: 'sub',
    userNameStrategy: 'username',
    adminGroup: 'acme-admins',
  },
  {
    name: 'globex',
    protocol: 'oidc',
    domain: 'globex.test',
    claimsDomain: true,
    matchClaim: 'sub',
    userNameStrategy: 'email',
  },
  // SAML, matched on an attribute carrying the Keycloak user id, on a domain no connection claims.
  {
    name: 'initech',
    protocol: 'saml',
    domain: 'initech.test',
    claimsDomain: false,
    matchClaim: 'kcUserId',
    userNameStrategy: 'username',
  },
]

export const realmNamed = (name: Realm['name']) => realms.find((realm) => realm.name === name)!
