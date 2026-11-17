/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A Keycloak-driven initial sync: import users with no events, run "Synchronize all users", and
 * time how long the extension takes to provision them all. Runs only with KEYCLOAK_LOAD_USERS set
 * (`bun run test:keycloak:load`), against a backend started with RATE_LIMIT_ENABLED=true, so the
 * per-credential SCIM budget applies as in a deployment.
 */

import { describe, expect, it } from 'bun:test'
import { realmNamed } from './lib/config'
import { realmContext, unique } from './lib/stack'
import { sql } from './lib/thunderbolt'

const userCount = Number(process.env.KEYCLOAK_LOAD_USERS ?? 0)
const importBatch = 500
/** A sync that makes no progress for this long has stalled; another one drains what is pending. */
const stallMs = 90_000

const globex = realmContext(realmNamed('globex'))

const provisionedCount = async (prefix: string) =>
  (
    await sql<{ count: number }[]>`
      select count(*)::int as count from scim_user u
      join identity_connection c on c.scim_connection_id = u.connection_id
      where c.id = ${globex.connectionId} and u.user_name like ${`${prefix}%`}`
  )[0].count

describe.skipIf(!userCount)(`Keycloak full sync of ${userCount} users`, () => {
  it(
    'provisions every imported user',
    async () => {
      const prefix = `load-${unique()}-`
      for (let offset = 0; offset < userCount; offset += importBatch) {
        const size = Math.min(importBatch, userCount - offset)
        await globex.keycloak.importUsers(
          Array.from({ length: size }, (_, index) => ({
            username: `${prefix}${offset + index}`,
            email: `${prefix}${offset + index}@globex.test`,
          })),
        )
      }

      const start = Date.now()
      const syncs: unknown[] = [await globex.syncAll()]
      let last = { count: await provisionedCount(prefix), at: Date.now() }
      while (last.count < userCount) {
        await Bun.sleep(5_000)
        const count = await provisionedCount(prefix)
        if (count > last.count) {
          last = { count, at: Date.now() }
        } else if (Date.now() - last.at > stallMs) {
          syncs.push(await globex.syncAll())
          last = { count, at: Date.now() }
        }
      }
      const minutes = (Date.now() - start) / 60_000

      // eslint-disable-next-line no-console -- The measurement is this suite's output.
      console.log(
        `Keycloak full sync: ${userCount} users in ${minutes.toFixed(1)} min ` +
          `(${Math.round(userCount / minutes)} users/min), ${syncs.length} sync run(s):`,
        JSON.stringify(syncs),
      )
      expect(await provisionedCount(prefix)).toBe(userCount)
    },
    4 * 60 * 60_000,
  )
})
