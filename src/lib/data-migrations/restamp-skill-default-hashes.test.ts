/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { defaultSkillDailyBrief, defaultSkillImportantEmails, defaultSkills, hashSkill } from '@/defaults/skills'
import { getDb } from '@/db/database'
import { settingsTable, skillsTable } from '@/db/tables'
import { reconcileDefaults, versionMarkerKeys } from '@/lib/reconcile-defaults'
import { hashValues } from '@/lib/utils'
import type { Skill } from '@/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { restampSkillDefaultHashes } from './restamp-skill-default-hashes'

// Mirrors the frozen legacy formula inside the migration — six fields, no
// `label` — so the test seeds hashes exactly as pre-v2 builds stamped them.
const legacyHashSkill = (skill: Skill): string =>
  hashValues([skill.name, skill.description, skill.instruction, skill.enabled, skill.pinnedOrder, skill.deletedAt])

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

/** Seed a default-skill row exactly as a pre-label (v1) build left it. */
const seedLegacyDefaultRow = async (skill: Skill) => {
  await getDb()
    .insert(skillsTable)
    .values({ ...skill, label: null, defaultHash: legacyHashSkill(skill) })
}

describe('restampSkillDefaultHashes', () => {
  it('re-stamps pristine legacy rows to the current hash formula', async () => {
    await seedLegacyDefaultRow(defaultSkillDailyBrief)

    await restampSkillDefaultHashes.run(getDb())

    const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, defaultSkillDailyBrief.id)).get()
    expect(row?.defaultHash).toBe(hashSkill({ ...defaultSkillDailyBrief, label: null }))
  })

  it('is idempotent — a second run changes nothing', async () => {
    await seedLegacyDefaultRow(defaultSkillDailyBrief)

    await restampSkillDefaultHashes.run(getDb())
    const first = await getDb().select().from(skillsTable).where(eq(skillsTable.id, defaultSkillDailyBrief.id)).get()
    await restampSkillDefaultHashes.run(getDb())
    const second = await getDb().select().from(skillsTable).where(eq(skillsTable.id, defaultSkillDailyBrief.id)).get()

    expect(second?.defaultHash).toBe(first?.defaultHash ?? '')
  })

  it('leaves user-created skills (no defaultHash) untouched', async () => {
    await getDb().insert(skillsTable).values({
      id: 'user-skill',
      name: 'my-skill',
      label: null,
      description: 'mine',
      instruction: 'do it',
      enabled: 1,
      pinnedOrder: null,
      deletedAt: null,
      defaultHash: null,
      userId: 'user-1',
    })

    await restampSkillDefaultHashes.run(getDb())

    const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, 'user-skill')).get()
    expect(row?.defaultHash).toBeNull()
  })

  it('leaves user-edited default rows (stale hash) untouched', async () => {
    // The user edited the instruction after seeding: content no longer hashes
    // to the stored value under either formula.
    const staleHash = legacyHashSkill(defaultSkillImportantEmails)
    await getDb()
      .insert(skillsTable)
      .values({
        ...defaultSkillImportantEmails,
        label: null,
        instruction: 'user-edited instruction',
        defaultHash: staleHash,
      })

    await restampSkillDefaultHashes.run(getDb())

    const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, defaultSkillImportantEmails.id)).get()
    expect(row?.defaultHash).toBe(staleHash)
  })

  it('unblocks reconcile: labels apply and the version marker advances after re-stamp', async () => {
    for (const skill of defaultSkills) {
      await seedLegacyDefaultRow(skill)
    }
    await getDb().insert(settingsTable).values({ key: versionMarkerKeys.skills, value: '1' })

    await restampSkillDefaultHashes.run(getDb())
    await reconcileDefaults(getDb())

    for (const skill of defaultSkills) {
      const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, skill.id)).get()
      expect(row?.label).toBe(skill.label ?? null)
      expect(row?.defaultHash).toBe(hashSkill(skill))
    }
    const marker = await getDb()
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, versionMarkerKeys.skills))
      .get()
    expect(marker?.value).toBe('2')
  })
})
