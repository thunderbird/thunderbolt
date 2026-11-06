/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { asc } from 'drizzle-orm'
import { getDb } from '@/db/database'
import { agentsTable } from '@/db/tables'
import { hasSetting } from '@/dal/settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { agentsReencryptedMarker, createReencryptAgents } from './reencrypt-agents'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

const armedGates = { hasStagedAK: async () => true, hasCompletedSync: () => true }

const seedAgent = async (input: { id: string; name: string; deletedAt?: string | null }) => {
  await getDb()
    .insert(agentsTable)
    .values({
      id: input.id,
      name: input.name,
      type: 'remote-acp',
      transport: 'websocket',
      url: `wss://example.com/${input.id}`,
      description: null,
      icon: null,
      enabled: 1,
      deletedAt: input.deletedAt ?? null,
      userId: 'user-1',
    })
}

const allAgents = () => getDb().select().from(agentsTable).orderBy(asc(agentsTable.id))

describe('reencryptAgents', () => {
  it('re-saves every row (soft-deleted included) preserving values, then writes the marker', async () => {
    await seedAgent({ id: 'a1', name: 'Agent One' })
    await seedAgent({ id: 'a2', name: 'Agent Two', deletedAt: '2026-01-01T00:00:00.000Z' })
    const before = await allAgents()

    await createReencryptAgents(armedGates).run(getDb())

    expect(await allAgents()).toEqual(before)
    expect(await hasSetting(getDb(), agentsReencryptedMarker)).toBe(true)
  })

  it('skips WITHOUT the marker when no AK is staged — marking here would strand the rows', async () => {
    await seedAgent({ id: 'a1', name: 'Agent One' })

    await createReencryptAgents({ ...armedGates, hasStagedAK: async () => false }).run(getDb())

    expect(await hasSetting(getDb(), agentsReencryptedMarker)).toBe(false)
  })

  it('skips WITHOUT the marker before a completed sync — the rows may not be local yet', async () => {
    await seedAgent({ id: 'a1', name: 'Agent One' })

    await createReencryptAgents({ ...armedGates, hasCompletedSync: () => false }).run(getDb())

    expect(await hasSetting(getDb(), agentsReencryptedMarker)).toBe(false)
  })

  it('skips WITHOUT the marker on zero local rows — indistinguishable from quarantined-before-landing', async () => {
    await createReencryptAgents(armedGates).run(getDb())

    expect(await hasSetting(getDb(), agentsReencryptedMarker)).toBe(false)
  })

  it('a present marker short-circuits before any gate is consulted', async () => {
    await seedAgent({ id: 'a1', name: 'Agent One' })
    await createReencryptAgents(armedGates).run(getDb())

    const gateCalls: string[] = []
    await createReencryptAgents({
      hasStagedAK: async () => {
        gateCalls.push('ak')
        return true
      },
      hasCompletedSync: () => {
        gateCalls.push('sync')
        return true
      },
    }).run(getDb())

    expect(gateCalls).toEqual([])
  })
})
