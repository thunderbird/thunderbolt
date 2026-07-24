/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { skillsTable } from '@/db/tables'
import { defaultSkillDailyBrief, defaultSkillWeatherForecast, hashSkill } from '@/defaults/skills'
import { hashValues } from '@/lib/utils'
import type { Skill } from '@/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { restampWidgetSkillDefaultHashes } from './restamp-widget-skill-default-hashes'

/** Hash formula used before widget contracts moved to content-only hashes. */
const legacyHashSkill = (skill: Skill): string =>
  hashValues([
    skill.name,
    skill.label,
    skill.description,
    skill.instruction,
    skill.enabled,
    skill.pinnedOrder,
    skill.deletedAt,
  ])

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

describe('restampWidgetSkillDefaultHashes', () => {
  it('re-stamps toggled widget rows without changing user state', async () => {
    const toggledWidget = {
      ...defaultSkillWeatherForecast,
      enabled: 0,
      pinnedOrder: 4,
      defaultHash: legacyHashSkill(defaultSkillWeatherForecast),
    }
    await getDb().insert(skillsTable).values(toggledWidget)

    await restampWidgetSkillDefaultHashes.run(getDb())

    const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, toggledWidget.id)).get()
    expect(row?.defaultHash).toBe(hashSkill(toggledWidget))
    expect(row?.enabled).toBe(0)
    expect(row?.pinnedOrder).toBe(4)
  })

  it('leaves task-skill hashes untouched', async () => {
    const staleHash = legacyHashSkill(defaultSkillDailyBrief)
    const toggledTask = { ...defaultSkillDailyBrief, enabled: 0, defaultHash: staleHash }
    await getDb().insert(skillsTable).values(toggledTask)

    await restampWidgetSkillDefaultHashes.run(getDb())

    const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, toggledTask.id)).get()
    expect(row?.defaultHash).toBe(staleHash)
  })

  it('is idempotent for widget rows already using the content-only hash', async () => {
    const currentHash = hashSkill(defaultSkillWeatherForecast)
    await getDb()
      .insert(skillsTable)
      .values({ ...defaultSkillWeatherForecast, defaultHash: currentHash })

    await restampWidgetSkillDefaultHashes.run(getDb())

    const row = await getDb().select().from(skillsTable).where(eq(skillsTable.id, defaultSkillWeatherForecast.id)).get()
    expect(row?.defaultHash).toBe(currentHash)
  })
})
