/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import postgres from 'postgres'
import { backendUrl, keycloakDatabaseUrl, type Realm } from './config'
import { keycloakRealm } from './keycloak-admin'
import { readState } from './state'
import { asCaller, bearer, scimUserOf, sql } from './thunderbolt'
import { waitFor } from './wait-for'

/** The stack setup.ts connected. Every suite reads it once. */
export const stack = readState()

export const admin = asCaller(bearer(stack.adminBearer))

export const unique = () => crypto.randomUUID().slice(0, 8)

const composeArgs = [
  'docker',
  'compose',
  '-f',
  join(import.meta.dir, '..', 'docker-compose.yml'),
  '--env-file',
  join(import.meta.dir, '..', 'extension.lock'),
]

/** Run `docker compose` against the stack, for the outage cases. Returns its output. */
export const compose = (...args: string[]) => {
  const run = Bun.spawnSync([...composeArgs, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(' ')}: ${run.stderr.toString()}`)
  }
  return run.stdout.toString() + run.stderr.toString()
}

/** One realm as the suites drive it: its Keycloak admin API and its Thunderbolt connection. */
export const realmContext = (realm: Realm) => {
  const state = stack.realms[realm.name]
  const keycloak = keycloakRealm(realm.name)
  /** A SCIM request with this realm's token, as the extension would send it. */
  const scim = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${backendUrl}/v1/api/auth/scim/v2${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${state.scimToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/scim+json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
  }
  return {
    realm,
    state,
    keycloak,
    scim,
    connectionId: state.identityConnectionId,
    /** A fresh user's names in this realm: a username and an address on its domain. */
    newUserNames: () => {
      const username = `kc-${unique()}`
      return { username, email: `${username}@${realm.domain}` }
    },
    /** Wait until the connection holds a SCIM user for this Keycloak user that passes `accept`. */
    scimUser: (
      keycloakUserId: string,
      accept: (row: NonNullable<Awaited<ReturnType<typeof scimUserOf>>>) => boolean = () => true,
    ) =>
      waitFor(`${realm.name} SCIM user ${keycloakUserId}`, async () => {
        const row = await scimUserOf(state.identityConnectionId, keycloakUserId)
        return row && accept(row) ? row : null
      }),
    /** Wait until this connection's source on the user has `status`. */
    sourceStatus: (userId: string, status: 'active' | 'suspended' | 'removed') =>
      waitFor(`${realm.name} source of ${userId} to be ${status}`, async () => {
        const [row] = await sql<{ status: string }[]>`
          select s.status from membership_source s join org_membership m on m.id = s.membership_id
          where m.user_id = ${userId} and s.kind = 'scim' and s.identity_connection_id = ${state.identityConnectionId}`
        return row?.status === status ? row : null
      }),
    syncAll: () => keycloak.syncAllUsers(state.targetId),
    /**
     * The extension's documented operator recovery for a create it marked `create_outcome_unknown`:
     * it treats any 409 as a create that might have happened, and never sends that POST again on
     * its own. Reset the one row, as its architecture notes say, once the review is resolved.
     */
    retryUncertainCreate: async (keycloakUserId: string) => {
      const keycloakSql = postgres(keycloakDatabaseUrl, { max: 1, onnotice: () => {} })
      try {
        const reset = await keycloakSql`
          update scim_outbound_resource set create_uncertain = false, next_attempt = 0
          where target_id = ${state.targetId} and resource_type = 'Users' and source_id = ${keycloakUserId}
            and create_uncertain`
        return reset.count
      } finally {
        await keycloakSql.end()
      }
    },
    setDeprovisionAction: (action: 'deactivate' | 'delete') =>
      keycloak.updateScimTarget(state.targetId, { deprovisionAction: action }),
  }
}

export type RealmContext = ReturnType<typeof realmContext>

/** The audit events about one target, newest first, through the admin API. */
export const auditEventsOf = async (targetId: string) =>
  (
    await admin.get<{
      events: {
        action: string
        outcome: string
        connectionId: string | null
        actorType: string
        metadata: Record<string, unknown> | null
      }[]
    }>(`/admin/audit-events?targetId=${targetId}&limit=100`)
  ).body.events
