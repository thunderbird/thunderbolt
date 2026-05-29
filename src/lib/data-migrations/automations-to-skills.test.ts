/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { promptsTable, skillsTable, triggersTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { hashValues } from '@/lib/utils'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { automationsToSkills } from './automations-to-skills'
import { deriveSkillIdFromAutomationId } from './derive-skill-id'

// Mirrors the private hashAutomationRow helper in automations-to-skills.ts —
// we duplicate it here so the test verifies the migration's hash contract
// without coupling to legacy defaults/automations.ts (deleted in THU-560).
const hashAutomationRow = (row: {
  title: string | null
  prompt: string | null
  modelId: string | null
  deletedAt: string | null
}) => hashValues([row.title, row.prompt, row.modelId, row.deletedAt])

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

const seedAutomation = async (input: { id: string; title: string; prompt: string; userId?: string }) => {
  await getDb()
    .insert(promptsTable)
    .values({
      id: input.id,
      title: input.title,
      prompt: input.prompt,
      modelId: null,
      deletedAt: null,
      defaultHash: null,
      userId: input.userId ?? 'user-1',
    })
}

const seedTrigger = async (input: { id: string; promptId: string }) => {
  await getDb().insert(triggersTable).values({
    id: input.id,
    triggerType: 'time',
    triggerTime: '09:00',
    promptId: input.promptId,
    isEnabled: 1,
    deletedAt: null,
    userId: 'user-1',
  })
}

describe('automationsToSkills', () => {
  it('is a no-op when there are no automations', async () => {
    await automationsToSkills.run(getDb())
    const skills = await getDb().select().from(skillsTable).where(isNull(skillsTable.deletedAt))
    // setupTestDatabase reconciles defaults; the migration shouldn't have
    // added any non-default skills.
    expect(skills.every((s) => s.defaultHash !== null)).toBe(true)
  })

  it('migrates an automation into a skill, soft-deletes the source, and pins it', async () => {
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })
    await automationsToSkills.run(getDb())

    const expectedId = await deriveSkillIdFromAutomationId('aut-1')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeDefined()
    expect(skill?.name).toBe('daily-review')
    expect(skill?.instruction).toBe('Summarize my day.')
    expect(skill?.description).toBe('Migrated from automation: Daily Review')
    expect(skill?.enabled).toBe(1)
    expect(skill?.deletedAt).toBeNull()
    expect(skill?.pinnedOrder).toBe(0)
    expect(skill?.userId).toBe('user-1')

    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-1')).get()
    expect(source?.deletedAt).not.toBeNull()
    expect(source?.title).toBeNull()
    expect(source?.prompt).toBeNull()
  })

  it('soft-deletes triggers attached to the migrated automation', async () => {
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })
    await seedTrigger({ id: 'trg-1', promptId: 'aut-1' })

    await automationsToSkills.run(getDb())

    const trigger = await getDb().select().from(triggersTable).where(eq(triggersTable.id, 'trg-1')).get()
    expect(trigger?.deletedAt).not.toBeNull()
  })

  it('skips automations whose slug collides with an existing skill', async () => {
    // Seed a skill that occupies the slug we'd want to migrate into.
    await getDb().insert(skillsTable).values({
      id: 'pre-existing',
      name: 'daily-review',
      description: 'pre-existing',
      instruction: 'do the thing',
      enabled: 1,
      pinnedOrder: null,
      deletedAt: null,
      defaultHash: null,
      userId: 'user-1',
    })
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })

    await automationsToSkills.run(getDb())

    // Source automation is *not* soft-deleted — collision strands it for
    // the user to resolve.
    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-1')).get()
    expect(source?.deletedAt).toBeNull()
    expect(source?.title).toBe('Daily Review')

    // No new skill was created at the derived id.
    const expectedId = await deriveSkillIdFromAutomationId('aut-1')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeUndefined()
  })

  it('is idempotent when run twice', async () => {
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })

    await automationsToSkills.run(getDb())
    await automationsToSkills.run(getDb())

    const expectedId = await deriveSkillIdFromAutomationId('aut-1')
    const skills = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId))
    expect(skills.length).toBe(1)
    expect(skills[0]?.deletedAt).toBeNull()
  })

  it('respects the 10-pin cap when migrating many automations', async () => {
    // 12 automations + 0 existing pins -> first 10 should get pinned, last 2 unpinned.
    for (let i = 0; i < 12; i++) {
      const id = `aut-${String(i).padStart(2, '0')}`
      await seedAutomation({ id, title: `Automation ${i}`, prompt: `prompt ${i}` })
    }

    await automationsToSkills.run(getDb())

    const pinnedSkills = await getDb()
      .select()
      .from(skillsTable)
      .where(and(isNull(skillsTable.deletedAt), isNotNull(skillsTable.pinnedOrder)))
    expect(pinnedSkills.length).toBe(10)

    const unpinnedMigrated = await getDb()
      .select()
      .from(skillsTable)
      .where(and(isNull(skillsTable.deletedAt), isNull(skillsTable.pinnedOrder), isNull(skillsTable.defaultHash)))
    expect(unpinnedMigrated.length).toBe(2)
  })

  it('soft-deletes unmodified default-hashed automations without migrating', async () => {
    // Seed an automation that looks like an unmodified default: its
    // defaultHash equals hashAutomationRow(itself).
    const defaultRow = {
      id: 'aut-default-1',
      title: 'Default Brief',
      prompt: 'Do the default thing.',
      modelId: null,
      deletedAt: null,
      defaultHash: null as string | null,
      userId: 'user-1',
    }
    defaultRow.defaultHash = hashAutomationRow(defaultRow)
    await getDb().insert(promptsTable).values(defaultRow)

    await automationsToSkills.run(getDb())

    // No new skill at the derived id (we skipped the migration).
    const expectedId = await deriveSkillIdFromAutomationId('aut-default-1')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeUndefined()

    // Source automation is soft-deleted (equivalent default skill lives in
    // the skills defaults system).
    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-default-1')).get()
    expect(source?.deletedAt).not.toBeNull()
    expect(source?.title).toBeNull()
    expect(source?.prompt).toBeNull()
  })

  it('migrates a customized default-hashed automation through the normal path', async () => {
    // A row that was once a default (defaultHash set) but the user has
    // since edited the prompt — current hash no longer matches defaultHash.
    const original = {
      id: 'aut-customized-1',
      title: 'Edited Brief',
      prompt: 'Original prompt',
      modelId: null,
      deletedAt: null,
      defaultHash: null as string | null,
      userId: 'user-1',
    }
    original.defaultHash = hashAutomationRow(original)
    // Mutate the prompt — defaultHash now refers to the original content,
    // not the current content.
    const customized = { ...original, prompt: 'User has edited this prompt.' }
    await getDb().insert(promptsTable).values(customized)

    await automationsToSkills.run(getDb())

    const expectedId = await deriveSkillIdFromAutomationId('aut-customized-1')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeDefined()
    expect(skill?.instruction).toBe('User has edited this prompt.')
  })

  it('skips already-soft-deleted automations', async () => {
    await getDb().insert(promptsTable).values({
      id: 'aut-deleted',
      title: null,
      prompt: null,
      modelId: null,
      deletedAt: '2025-01-01T00:00:00.000Z',
      defaultHash: null,
      userId: 'user-1',
    })

    await automationsToSkills.run(getDb())

    const expectedId = await deriveSkillIdFromAutomationId('aut-deleted')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeUndefined()
  })
})
