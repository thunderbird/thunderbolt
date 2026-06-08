/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { wsId } from '@/dal/test-utils'

import { getDb } from '@/db/database'
import { promptsTable, skillsTable, triggersTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { hashValues } from '@/lib/utils'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
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
      workspaceId: wsId,
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
    workspaceId: wsId,
  })
}

describe('automationsToSkills', () => {
  it('is a no-op when there are no automations', async () => {
    // `resetTestDatabase` skips default reconciliation, so reconcile here to
    // give the assertion something real to check — without seeded defaults,
    // the table is empty and `every` would pass vacuously.
    await reconcileDefaults(getDb(), '00000000-0000-0000-0000-000000000001')
    const before = await getDb().select().from(skillsTable).where(isNull(skillsTable.deletedAt))
    expect(before.length).toBeGreaterThan(0)

    await automationsToSkills.run(getDb(), wsId)

    const after = await getDb().select().from(skillsTable).where(isNull(skillsTable.deletedAt))
    // No new skills added, and every surviving skill is still a default.
    expect(after.length).toBe(before.length)
    expect(after.every((s) => s.defaultHash !== null)).toBe(true)
  })

  it('migrates an automation into a skill, soft-deletes the source, and pins it', async () => {
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })
    await automationsToSkills.run(getDb(), wsId)

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

    await automationsToSkills.run(getDb(), wsId)

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
      workspaceId: wsId,
    })
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })

    await automationsToSkills.run(getDb(), wsId)

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

    await automationsToSkills.run(getDb(), wsId)
    await automationsToSkills.run(getDb(), wsId)

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

    await automationsToSkills.run(getDb(), wsId)

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

  it('does not collide with non-contiguous existing pinnedOrder values', async () => {
    // Seed existing skills at sparse pin slots [0, 1, 5] — the kind of
    // shape a user produces by unpinning a middle skill without
    // reordering. Naive `existingPinned.length` (3) would reassign 3, 4, 5
    // and clobber the skill at slot 5.
    for (const [i, order] of [
      [0, 0],
      [1, 1],
      [2, 5],
    ]) {
      await getDb()
        .insert(skillsTable)
        .values({
          id: `pre-${i}`,
          name: `pre-${i}`,
          description: 'pre-existing',
          instruction: 'do the thing',
          enabled: 1,
          pinnedOrder: order,
          deletedAt: null,
          defaultHash: null,
          userId: 'user-1',
          workspaceId: wsId,
        })
    }
    await seedAutomation({ id: 'aut-1', title: 'Daily Review', prompt: 'Summarize my day.' })

    await automationsToSkills.run(getDb(), wsId)

    // Migrated skill should land at slot 6 (max(0,1,5) + 1), not 3.
    const expectedId = await deriveSkillIdFromAutomationId('aut-1')
    const migrated = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(migrated?.pinnedOrder).toBe(6)

    // Existing skills are untouched.
    const preserved = await getDb()
      .select({ id: skillsTable.id, pinnedOrder: skillsTable.pinnedOrder })
      .from(skillsTable)
      .where(and(isNotNull(skillsTable.pinnedOrder), isNull(skillsTable.deletedAt)))
    const orders = preserved.map((s) => s.pinnedOrder).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(orders).toEqual([0, 1, 5, 6])
  })

  it('does not destroy prompt content when only the title is empty', async () => {
    // User cleared the title field of an existing automation but the prompt
    // is intact. The migration must NOT route this through the "husk"
    // soft-delete (which would null the surviving prompt) — it should be
    // stranded so the user's content stays recoverable in `promptsTable`.
    await getDb().insert(promptsTable).values({
      id: 'aut-title-cleared',
      title: null,
      prompt: 'This prompt should survive.',
      modelId: null,
      deletedAt: null,
      defaultHash: null,
      userId: 'user-1',
      workspaceId: wsId,
    })

    await automationsToSkills.run(getDb(), wsId)

    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-title-cleared')).get()
    expect(source?.deletedAt).toBeNull()
    expect(source?.prompt).toBe('This prompt should survive.')

    const expectedId = await deriveSkillIdFromAutomationId('aut-title-cleared')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeUndefined()
  })

  it('does not destroy title content when only the prompt is empty', async () => {
    // Mirror of the previous test for the other axis. Same invariant:
    // partial content is recoverable and must stay alive.
    await getDb().insert(promptsTable).values({
      id: 'aut-prompt-cleared',
      title: 'A Surviving Title',
      prompt: null,
      modelId: null,
      deletedAt: null,
      defaultHash: null,
      userId: 'user-1',
      workspaceId: wsId,
    })

    await automationsToSkills.run(getDb(), wsId)

    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-prompt-cleared')).get()
    expect(source?.deletedAt).toBeNull()
    expect(source?.title).toBe('A Surviving Title')
  })

  it('strands automations with non-slugifiable titles (leaves source alive)', async () => {
    // "!!!" produces an empty slug — there's no way to migrate this without
    // a UI to rename. THU-560's drop-the-table gate must not fire while
    // stranded rows still exist, which is why this branch returns
    // `stranded` for the telemetry counter rather than soft-deleting.
    await seedAutomation({ id: 'aut-junk', title: '!!!', prompt: 'do something' })

    await automationsToSkills.run(getDb(), wsId)

    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-junk')).get()
    expect(source?.deletedAt).toBeNull()
    expect(source?.title).toBe('!!!')

    const expectedId = await deriveSkillIdFromAutomationId('aut-junk')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeUndefined()
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
      workspaceId: wsId,
    }
    defaultRow.defaultHash = hashAutomationRow(defaultRow)
    await getDb().insert(promptsTable).values(defaultRow)

    await automationsToSkills.run(getDb(), wsId)

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
      workspaceId: wsId,
    }
    original.defaultHash = hashAutomationRow(original)
    // Mutate the prompt — defaultHash now refers to the original content,
    // not the current content.
    const customized = { ...original, prompt: 'User has edited this prompt.' }
    await getDb().insert(promptsTable).values(customized)

    await automationsToSkills.run(getDb(), wsId)

    const expectedId = await deriveSkillIdFromAutomationId('aut-customized-1')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeDefined()
    expect(skill?.instruction).toBe('User has edited this prompt.')
  })

  it('soft-deletes triggers attached to a no-content (husk) automation row', async () => {
    // A row that's still alive (deletedAt == null) but has been emptied of
    // its title/prompt content — a defensive branch in the migration that
    // also needs to clean up attached triggers.
    await getDb().insert(promptsTable).values({
      id: 'aut-husk',
      title: null,
      prompt: null,
      modelId: null,
      deletedAt: null,
      defaultHash: null,
      userId: 'user-1',
      workspaceId: wsId,
    })
    await seedTrigger({ id: 'trg-husk', promptId: 'aut-husk' })

    await automationsToSkills.run(getDb(), wsId)

    const source = await getDb().select().from(promptsTable).where(eq(promptsTable.id, 'aut-husk')).get()
    expect(source?.deletedAt).not.toBeNull()

    const trigger = await getDb().select().from(triggersTable).where(eq(triggersTable.id, 'trg-husk')).get()
    expect(trigger?.deletedAt).not.toBeNull()
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
      workspaceId: wsId,
    })

    await automationsToSkills.run(getDb(), wsId)

    const expectedId = await deriveSkillIdFromAutomationId('aut-deleted')
    const skill = await getDb().select().from(skillsTable).where(eq(skillsTable.id, expectedId)).get()
    expect(skill).toBeUndefined()
  })
})
