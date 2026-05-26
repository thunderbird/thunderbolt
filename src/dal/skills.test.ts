/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { skillsTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  createSkill,
  getAllSkills,
  getPinnedSkills,
  getSkill,
  getSkillByName,
  getSkillsByIds,
  maxPinnedSkills,
  PinLimitExceededError,
  reorderPins,
  setEnabled,
  setPinned,
  SkillNameTakenError,
  softDeleteSkill,
  updateSkill,
} from './skills'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

const seed = async (input: { name: string; description?: string; instruction?: string }) =>
  createSkill(getDb(), {
    name: input.name,
    description: input.description ?? `desc for ${input.name}`,
    instruction: input.instruction ?? `instruction for ${input.name}`,
  })

describe('skills DAL', () => {
  describe('createSkill', () => {
    it('inserts a skill with defaults (enabled=1, pinnedOrder=null)', async () => {
      const skill = await seed({ name: '/meeting-notes' })

      expect(skill.id).toBeTruthy()
      expect(skill.name).toBe('/meeting-notes')
      expect(skill.enabled).toBe(1)
      expect(skill.pinnedOrder).toBeNull()
      expect(skill.deletedAt).toBeNull()

      const fetched = await getSkill(getDb(), skill.id)
      expect(fetched?.name).toBe('/meeting-notes')
    })

    it('rejects duplicate names', async () => {
      await seed({ name: '/weekly-review' })
      await expect(seed({ name: '/weekly-review' })).rejects.toBeInstanceOf(SkillNameTakenError)
    })

    it('allows reusing a name after the original is soft-deleted (tombstone has name=NULL)', async () => {
      const first = await seed({ name: '/task-triage' })
      await softDeleteSkill(getDb(), first.id)
      const reborn = await seed({ name: '/task-triage' })
      expect(reborn.id).not.toBe(first.id)
    })
  })

  describe('updateSkill', () => {
    it('patches description without affecting other fields', async () => {
      const skill = await seed({ name: '/x' })
      await updateSkill(getDb(), skill.id, { description: 'new desc' })
      const after = await getSkill(getDb(), skill.id)
      expect(after?.description).toBe('new desc')
      expect(after?.name).toBe('/x')
    })

    it('rejects renaming to a name taken by another skill', async () => {
      const a = await seed({ name: '/a' })
      await seed({ name: '/b' })
      await expect(updateSkill(getDb(), a.id, { name: '/b' })).rejects.toBeInstanceOf(SkillNameTakenError)
    })

    it('allows renaming to the same name (no-op uniqueness check)', async () => {
      const a = await seed({ name: '/keepme' })
      await updateSkill(getDb(), a.id, { name: '/keepme', description: 'updated' })
      const after = await getSkill(getDb(), a.id)
      expect(after?.description).toBe('updated')
    })
  })

  describe('softDeleteSkill', () => {
    it('wipes name/description/instruction and stamps deletedAt', async () => {
      const skill = await seed({ name: '/wipeme' })
      await softDeleteSkill(getDb(), skill.id)

      // Bypass the DAL's soft-delete filter to inspect the tombstone directly.
      const tomb = await getDb().select().from(skillsTable).where(eq(skillsTable.id, skill.id)).get()
      expect(tomb?.deletedAt).toBeTruthy()
      expect(tomb?.name).toBeNull()
      expect(tomb?.description).toBeNull()
      expect(tomb?.instruction).toBeNull()
    })

    it('clears pinnedOrder on delete so the slot frees up for another skill', async () => {
      const skill = await seed({ name: '/pinned' })
      await setPinned(getDb(), skill.id, 0)
      await softDeleteSkill(getDb(), skill.id)

      const tomb = await getDb().select().from(skillsTable).where(eq(skillsTable.id, skill.id)).get()
      expect(tomb?.pinnedOrder).toBeNull()
    })

    it('omits soft-deleted skills from getAllSkills / getSkill / getSkillByName', async () => {
      const skill = await seed({ name: '/gone' })
      await softDeleteSkill(getDb(), skill.id)
      expect(await getSkill(getDb(), skill.id)).toBeNull()
      expect(await getSkillByName(getDb(), '/gone')).toBeNull()
      const all = await getAllSkills(getDb())
      expect(all.find((s) => s.id === skill.id)).toBeUndefined()
    })
  })

  describe('setPinned', () => {
    it('pins and unpins', async () => {
      const skill = await seed({ name: '/p' })
      await setPinned(getDb(), skill.id, 0)
      expect((await getSkill(getDb(), skill.id))?.pinnedOrder).toBe(0)
      await setPinned(getDb(), skill.id, null)
      expect((await getSkill(getDb(), skill.id))?.pinnedOrder).toBeNull()
    })

    it(`rejects pinning the (${maxPinnedSkills}+1)th skill`, async () => {
      for (let i = 0; i < maxPinnedSkills; i++) {
        const s = await seed({ name: `/pin-${i}` })
        await setPinned(getDb(), s.id, i)
      }
      const overflow = await seed({ name: '/overflow' })
      await expect(setPinned(getDb(), overflow.id, maxPinnedSkills)).rejects.toBeInstanceOf(PinLimitExceededError)
    })

    it('lets an already-pinned skill update its position without tripping the cap', async () => {
      const skills = []
      for (let i = 0; i < maxPinnedSkills; i++) {
        const s = await seed({ name: `/cap-${i}` })
        await setPinned(getDb(), s.id, i)
        skills.push(s)
      }
      // Re-pin one of them to a new position — still 10 pins total.
      await setPinned(getDb(), skills[0]!.id, 5)
      expect((await getSkill(getDb(), skills[0]!.id))?.pinnedOrder).toBe(5)
    })
  })

  describe('setEnabled', () => {
    it('toggles enabled', async () => {
      const skill = await seed({ name: '/e' })
      await setEnabled(getDb(), skill.id, false)
      expect((await getSkill(getDb(), skill.id))?.enabled).toBe(0)
      await setEnabled(getDb(), skill.id, true)
      expect((await getSkill(getDb(), skill.id))?.enabled).toBe(1)
    })
  })

  describe('reorderPins', () => {
    it('rewrites pinned_order to match the supplied id sequence', async () => {
      const a = await seed({ name: '/a' })
      const b = await seed({ name: '/b' })
      const c = await seed({ name: '/c' })
      await setPinned(getDb(), a.id, 0)
      await setPinned(getDb(), b.id, 1)
      await setPinned(getDb(), c.id, 2)

      await reorderPins(getDb(), [c.id, a.id, b.id])

      const pinned = await getPinnedSkills(getDb())
      expect(pinned.map((s) => s.id)).toEqual([c.id, a.id, b.id])
    })

    it(`rejects more than ${maxPinnedSkills} ids`, async () => {
      const ids = Array.from({ length: maxPinnedSkills + 1 }, () => crypto.randomUUID())
      await expect(reorderPins(getDb(), ids)).rejects.toBeInstanceOf(PinLimitExceededError)
    })
  })

  describe('getSkillsByIds', () => {
    it('returns skills by id, skipping soft-deleted', async () => {
      const a = await seed({ name: '/a' })
      const b = await seed({ name: '/b' })
      await softDeleteSkill(getDb(), b.id)
      const rows = await getSkillsByIds(getDb(), [a.id, b.id])
      expect(rows.map((s) => s.id)).toEqual([a.id])
    })
  })
})
