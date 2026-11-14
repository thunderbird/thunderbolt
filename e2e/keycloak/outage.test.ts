/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Outages in both directions, with real Keycloak. Thunderbolt unreachable from Keycloak: the
 * extension keeps the work pending, says so in its log, and catches up when it is back. Keycloak
 * down: members keep working from Thunderbolt's own records, a new SSO sign-in fails visibly, and
 * the break-glass admin still gets in. Local only, like realm-matrix.test.ts; stops and starts
 * containers of the stack.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { adminEmail, keycloakUrl, realmNamed } from './lib/config'
import { signInThroughKeycloak } from './lib/sso-login'
import { compose, realmContext } from './lib/stack'
import { request, sessionUser, signInByEmailCode, userByEmail } from './lib/thunderbolt'
import { waitFor } from './lib/wait-for'

const acme = realmContext(realmNamed('acme'))

const keycloakUp = async () => {
  try {
    return (await fetch(`${keycloakUrl}/realms/master`)).ok || null
  } catch {
    return null
  }
}

afterAll(async () => {
  compose('up', '-d', 'keycloak', 'scim-loopback')
  await waitFor('Keycloak', keycloakUp, { timeoutMs: 180_000, intervalMs: 2_000 })
})

describe('Thunderbolt unreachable from Keycloak', () => {
  it('keeps changes pending, logs why, and applies them when Thunderbolt is back', async () => {
    const existing = acme.newUserNames()
    const existingId = await acme.keycloak.createUser(existing)
    const before = await acme.scimUser(existingId)
    const since = new Date().toISOString()

    compose('stop', 'scim-loopback')
    const created = acme.newUserNames()
    const createdId = await acme.keycloak.createUser(created)
    await acme.keycloak.updateUser(existingId, { firstName: 'Offline' })
    await acme.keycloak.updateUser(existingId, { enabled: false })

    const pending = await waitFor(
      'a pending-work log line',
      async () => {
        const log = compose('logs', '--since', since, 'keycloak')
        return log.includes('SCIM work pending') ? log : null
      },
      { timeoutMs: 60_000, intervalMs: 2_000 },
    )
    expect(pending).toMatch(/SCIM work pending: target=\S+ resource=\S+ reason=\S+/)
    expect(await userByEmail(created.email)).toBeNull()

    const restoredAt = Date.now()
    compose('start', 'scim-loopback')

    // Background retries (every 10 s in this stack, with backoff) deliver without anyone acting.
    const createdRow = await acme.scimUser(createdId)
    await acme.scimUser(existingId, (row) => !row.active)
    expect(createdRow.userId).not.toBe(before.userId)
    // eslint-disable-next-line no-console -- The recovery time is part of what this suite reports.
    console.log(`Keycloak caught up ${Math.round((Date.now() - restoredAt) / 1000)}s after Thunderbolt came back`)
  }, 300_000)
})

describe('Keycloak down', () => {
  it('keeps members working, fails a new SSO sign-in visibly, and lets the break-glass admin in', async () => {
    const member = acme.newUserNames()
    const memberId = await acme.keycloak.createUser(member)
    const { userId } = await acme.scimUser(memberId)
    const { cookie } = await signInThroughKeycloak('acme', member.username)

    compose('stop', 'scim-loopback', 'keycloak')
    try {
      const discovery = await request<{ connections: unknown[] }>('POST', '/sso/discover', {
        body: { email: member.email },
      })
      const newSignIn = await signInThroughKeycloak('acme', member.username).catch((error: Error) => error)
      const breakGlass = await signInByEmailCode(adminEmail)

      expect(await sessionUser({ Cookie: cookie })).toBe(userId)
      expect(discovery.status).toBe(200)
      expect(newSignIn).toMatchObject({ status: 502, cookie: '' })
      expect(breakGlass.status).toBe(200)
    } finally {
      compose('start', 'keycloak', 'scim-loopback')
    }
    await waitFor('Keycloak', keycloakUp, { timeoutMs: 180_000, intervalMs: 2_000 })

    const afterRecovery = await signInThroughKeycloak('acme', member.username)
    expect(await sessionUser({ Cookie: afterRecovery.cookie })).toBe(userId)
  }, 300_000)
})
