/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Several realms provisioning into one org: no collisions and no cross-connection writes, with the
 * seeded users the realms share names and addresses with. Local only, like realm-matrix.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { realmNamed } from './lib/config'
import { signInThroughKeycloak } from './lib/sso-login'
import { admin, auditEventsOf, realmContext, unique } from './lib/stack'
import { scimSourcesOf, sessionUser, userByEmail } from './lib/thunderbolt'
import { waitFor } from './lib/wait-for'

const acme = realmContext(realmNamed('acme'))
const globex = realmContext(realmNamed('globex'))
const initech = realmContext(realmNamed('initech'))

describe('realms in one org', () => {
  it('keeps the `alice` of two realms as two people, each signing in to their own user', async () => {
    const acmeAlice = await acme.keycloak.findUser('alice')
    const globexAlice = await globex.keycloak.findUser('alice')
    const acmeUser = await acme.scimUser(acmeAlice.id)
    const globexUser = await globex.scimUser(globexAlice.id)

    expect(acmeUser.userId).not.toBe(globexUser.userId)
    expect(await sessionUser({ Cookie: (await signInThroughKeycloak('acme', 'alice')).cookie })).toBe(acmeUser.userId)
    expect(await sessionUser({ Cookie: (await signInThroughKeycloak('globex', 'alice')).cookie })).toBe(
      globexUser.userId,
    )
  })

  it('holds the second realm to provision the same address for review, then links it without merging', async () => {
    // Fresh users each run; the seeded `pat` shows the same at setup's initial sync.
    const email = `contractor-${unique()}@contractor.test`
    const acmeId = await acme.keycloak.createUser({ username: email.split('@')[0], email })
    const { userId } = await acme.scimUser(acmeId)
    const name = (await userByEmail(email))!.name
    const initechId = await initech.keycloak.createUser({ username: email.split('@')[0], email, firstName: 'Other' })

    const review = await waitFor('the review', async () => {
      const page = await admin.get<{ reviews: { id: string; externalId: string; status: string }[] }>(
        `/admin/link-reviews?connectionId=${initech.connectionId}&status=pending`,
      )
      return page.body.reviews.find((row) => row.externalId === initechId)
    })
    expect((await scimSourcesOf(userId)).map((source) => source.connectionId)).toEqual([acme.connectionId])

    expect((await admin.post(`/admin/link-reviews/${review.id}/approve`)).status).toBe(200)
    // A sync alone never links: the extension looks the user up but doesn't send the create again.
    await initech.syncAll()
    await Bun.sleep(2_000)
    expect((await scimSourcesOf(userId)).map((source) => source.connectionId)).toEqual([acme.connectionId])
    expect(await initech.retryUncertainCreate(initechId)).toBe(1)
    await initech.syncAll()

    const linked = await initech.scimUser(initechId)
    expect(linked.userId).toBe(userId)
    expect((await scimSourcesOf(userId)).map((source) => source.connectionId).sort()).toEqual(
      [acme.connectionId, initech.connectionId].sort(),
    )
    // Only the first connection manages the profile: the second linked with `preserve`.
    expect((await userByEmail(email))!.name).toBe(name)
  })

  it("can't reach another realm's users with its own token", async () => {
    const globexAlice = await globex.scimUser((await globex.keycloak.findUser('alice')).id)

    const read = await acme.scim('GET', `/Users/${globexAlice.id}`)
    const write = await acme.scim('PATCH', `/Users/${globexAlice.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    })

    expect([read.status, write.status]).toEqual([404, 404])
    expect((await globex.scimUser((await globex.keycloak.findUser('alice')).id)).active).toBe(true)
  })

  it("attributes each realm's changes to its own connection", async () => {
    const globexAlice = await globex.scimUser((await globex.keycloak.findUser('alice')).id)

    const scimEvents = (await auditEventsOf(globexAlice.userId)).filter((event) => event.action.startsWith('scim.'))

    expect(scimEvents.length).toBeGreaterThan(0)
    for (const event of scimEvents) {
      expect(event).toMatchObject({ connectionId: globex.connectionId, actorType: 'scim_connection' })
    }
  })
})
