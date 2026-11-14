/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The whole feature, once per realm, against real Keycloak and the real outbound SCIM extension:
 * SSO sign-in, login discovery, and the SCIM lifecycle with groups and role mapping. Local only:
 * needs the stack from docker-compose.yml, the backend from backend.env, and `setup.ts`.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { realms } from './lib/config'
import { signInThroughKeycloak } from './lib/sso-login'
import { admin, auditEventsOf, realmContext } from './lib/stack'
import { request, sessionUser, signInByEmailCode, sql, userByEmail } from './lib/thunderbolt'
import { waitFor } from './lib/wait-for'

const rolesOf = async (userId: string) =>
  (await admin.get<{ roles: { role: string }[] }>(`/admin/members/${userId}`)).body.roles.map((grant) => grant.role)

describe.each(realms)('realm $name', (realm) => {
  const context = realmContext(realm)
  const { keycloak, connectionId } = context

  /** A user an admin creates in Keycloak, once Thunderbolt holds it. */
  const provisioned = async () => {
    const names = context.newUserNames()
    const keycloakId = await keycloak.createUser(names)
    const scimUser = await context.scimUser(keycloakId)
    return { ...names, keycloakId, scimUser, userId: scimUser.userId }
  }

  describe('SSO and discovery', () => {
    it("signs a provisioned user in through the realm's login form, onto their SCIM record's user", async () => {
      const user = await provisioned()

      const signIn = await signInThroughKeycloak(realm.name, user.username)

      expect(signIn.error).toBeNull()
      expect(await sessionUser({ Cookie: signIn.cookie })).toBe(user.userId)
      const signIns = (await auditEventsOf(user.userId)).filter((event) => event.action === 'auth.sign_in')
      expect(signIns[0]).toMatchObject({ outcome: 'success', connectionId, metadata: { method: realm.protocol } })
    })

    it('refuses a Keycloak user the extension never provisioned, and creates no user', async () => {
      const names = context.newUserNames()
      // Imported users raise no admin event, so the extension doesn't know them until a full sync.
      await keycloak.importUsers([names])

      const signIn = await signInThroughKeycloak(realm.name, names.username)

      expect(signIn.error).toBe('ACCESS_NOT_MEMBER')
      expect(await userByEmail(names.email)).toBeNull()
    })

    it("offers only the realm's connection for a claimed domain, and every connection otherwise", async () => {
      const discover = async (email: string) =>
        (
          await request<{ connections: { providerId: string }[] }>('POST', '/sso/discover', { body: { email } })
        ).body.connections.map((connection) => connection.providerId)
      const all = await discover('someone@unclaimed.test')

      expect(all.sort()).toEqual(['acme', 'globex', 'initech', 'sso'])
      expect(await discover(`nobody-${crypto.randomUUID()}@${realm.domain}`)).toEqual(
        realm.claimsDomain ? [realm.name] : all,
      )
    })
  })

  describe('SCIM lifecycle', () => {
    it('provisions a new Keycloak user as a member through this connection, with a verified email', async () => {
      const user = await provisioned()

      const [row] = await sql<{ emailVerified: boolean }[]>`
        select email_verified as "emailVerified" from "user" where id = ${user.userId}`
      expect(row.emailVerified).toBe(true)
      expect(await context.sourceStatus(user.userId, 'active')).toBeTruthy()
      const created = (await auditEventsOf(user.userId)).find((event) => event.action === 'scim.user_created')
      expect(created).toMatchObject({ connectionId, actorType: 'scim_connection' })
    })

    it('follows a profile update, a username change and an email change', async () => {
      const user = await provisioned()
      const email = `moved-${user.username}@${realm.domain}`

      await keycloak.updateUser(user.keycloakId, { firstName: 'Renamed', email })
      if (realm.userNameStrategy === 'username') {
        await keycloak.updateUser(user.keycloakId, { username: `${user.username}-renamed` })
      }

      const moved = await waitFor('the email change', () => userByEmail(email))
      expect(moved.id).toBe(user.userId)
      const expectedUserName = realm.userNameStrategy === 'username' ? `${user.username}-renamed` : email
      await context.scimUser(user.keycloakId, (row) => row.userName === expectedUserName)
      // The SCIM record takes the new given name. The user's display name doesn't follow: the
      // extension sends no `displayName` or `name.formatted`, and the plugin keeps the formatted name
      // it derived at create (a finding, see the results file).
      const [record] = await sql<{ givenName: string }[]>`
        select given_name as "givenName" from scim_user where external_id = ${user.keycloakId}`
      expect(record.givenName).toBe('Renamed')
    })

    it('suspends a disabled user, signs them out, refuses their email code, and lets them back on re-enable', async () => {
      const user = await provisioned()
      const { cookie } = await signInThroughKeycloak(realm.name, user.username)

      await keycloak.updateUser(user.keycloakId, { enabled: false })

      await context.sourceStatus(user.userId, 'suspended')
      expect(await sessionUser({ Cookie: cookie })).toBeNull()
      expect((await signInByEmailCode(user.email)).status).toBe(403)

      await keycloak.updateUser(user.keycloakId, { enabled: true })

      await context.sourceStatus(user.userId, 'active')
      const again = await signInThroughKeycloak(realm.name, user.username)
      expect(await sessionUser({ Cookie: again.cookie })).toBe(user.userId)
    })

    it('refuses an email-code sign-in by an active member: they sign in through SSO only', async () => {
      const user = await provisioned()

      const viaCode = await signInByEmailCode(user.email)

      expect(viaCode.status).toBe(403)
      expect(JSON.stringify(viaCode.body)).toContain('ACCESS_SSO_REQUIRED')
    })

    it('only suspends a user deleted in Keycloak while the target deactivates on delete', async () => {
      const user = await provisioned()

      await keycloak.deleteUser(user.keycloakId)

      await context.sourceStatus(user.userId, 'suspended')
      await context.scimUser(user.keycloakId, (row) => !row.active)
    })

    describe('with the target deleting on delete', () => {
      afterAll(async () => {
        await context.setDeprovisionAction('deactivate')
      })

      it('also deletes, once switched to delete, the users it had only deactivated', async () => {
        const user = await provisioned()
        await keycloak.deleteUser(user.keycloakId)
        await context.sourceStatus(user.userId, 'suspended')

        await context.setDeprovisionAction('delete')
        await context.syncAll()

        await context.sourceStatus(user.userId, 'removed')
      })

      it('removes the member, revokes their devices, and brings the same user back when the same Keycloak user returns', async () => {
        const user = await provisioned()
        const deviceId = crypto.randomUUID()
        await sql`insert into powersync.devices (id, user_id, trusted) values (${deviceId}, ${user.userId}, true)`

        await keycloak.deleteUser(user.keycloakId)

        await context.sourceStatus(user.userId, 'removed')
        const [device] = await sql<{ revokedAt: Date | null }[]>`
          select revoked_at as "revokedAt" from powersync.devices where id = ${deviceId}`
        expect(device.revokedAt).not.toBeNull()

        // The same Keycloak user (same id, so the same externalId) comes back at the next full sync.
        await keycloak.importUsers([{ id: user.keycloakId, username: user.username, email: user.email }])
        await context.syncAll()

        const back = await context.scimUser(user.keycloakId)
        expect(back.userId).toBe(user.userId)
        await context.sourceStatus(user.userId, 'active')
      })

      it('holds a recreated Keycloak user with a new id but the same email for review, without touching the old user', async () => {
        const user = await provisioned()
        await keycloak.deleteUser(user.keycloakId)
        await context.sourceStatus(user.userId, 'removed')

        const recreatedId = await keycloak.createUser({ username: `${user.username}-again`, email: user.email })

        const review = await waitFor('a link review', async () => {
          const page = await admin.get<{ reviews: { externalId: string; candidate: { id: string } }[] }>(
            `/admin/link-reviews?connectionId=${connectionId}&status=pending`,
          )
          return page.body.reviews.find((row) => row.externalId === recreatedId)
        })
        expect(review.candidate.id).toBe(user.userId)
        expect(await context.sourceStatus(user.userId, 'removed')).toBeTruthy()
      })
    })
  })

  describe('groups', () => {
    const groupRow = (groupId: string) =>
      sql<{ id: string; displayName: string }[]>`
        select g.id, g.display_name as "displayName" from scim_group g
        join identity_connection c on c.scim_connection_id = g.connection_id
        where c.id = ${connectionId} and g.external_id = ${groupId}`
    const memberCount = (scimGroupId: string) =>
      sql<{ count: number }[]>`select count(*)::int as count from scim_group_member where group_id = ${scimGroupId}`

    it('creates, fills, renames, empties and deletes a group', async () => {
      const user = await provisioned()
      const name = `team-${user.username}`
      const groupId = await keycloak.createGroup(name)
      const [group] = await waitFor('the group', async () =>
        (await groupRow(groupId)).length ? groupRow(groupId) : null,
      )

      await keycloak.addToGroup(user.keycloakId, groupId)
      await waitFor('the membership', async () => ((await memberCount(group.id))[0].count === 1 ? true : null))
      await keycloak.renameGroup(groupId, `${name}-renamed`)
      await waitFor('the rename', async () =>
        (await groupRow(groupId))[0]?.displayName === `${name}-renamed` ? true : null,
      )
      await keycloak.removeFromGroup(user.keycloakId, groupId)
      await waitFor('the removal', async () => ((await memberCount(group.id))[0].count === 0 ? true : null))
      await keycloak.deleteGroup(groupId)
      await waitFor('the deletion', async () => ((await groupRow(groupId)).length === 0 ? true : null))
    })

    it(
      realm.adminGroup
        ? 'grants the admin role through the mapped group by id, and keeps it across a rename'
        : 'grants nothing to a group merely named Admins',
      async () => {
        const user = await provisioned()
        const groupId = realm.adminGroup
          ? (await keycloak.findGroup(realm.adminGroup)).id
          : await keycloak.createGroup(`Admins-${user.username}`)

        await keycloak.addToGroup(user.keycloakId, groupId)
        await waitFor('the membership', async () => ((await groupRow(groupId)).length ? true : null))

        if (!realm.adminGroup) {
          await Bun.sleep(2_000)
          expect(await rolesOf(user.userId)).not.toContain('admin')
          return
        }
        await waitFor('the admin role', async () => ((await rolesOf(user.userId)).includes('admin') ? true : null))
        await keycloak.renameGroup(groupId, `${realm.adminGroup}-renamed`)
        await waitFor('the rename', async () =>
          (await groupRow(groupId))[0]?.displayName === `${realm.adminGroup}-renamed` ? true : null,
        )
        expect(await rolesOf(user.userId)).toContain('admin')
        await keycloak.renameGroup(groupId, realm.adminGroup)
        await keycloak.removeFromGroup(user.keycloakId, groupId)
        await waitFor('the role to go', async () => (!(await rolesOf(user.userId)).includes('admin') ? true : null))
      },
    )
  })
})
