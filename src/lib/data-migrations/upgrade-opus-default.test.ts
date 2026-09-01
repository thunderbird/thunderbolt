/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { modelsTable } from '@/db/tables'
import { defaultModelOpus5, hashModel, type SharedModel } from '@shared/defaults/models'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { normalizeOpusDefault, upgradeOpusDefault } from './upgrade-opus-default'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

/** Seed the shared row id as it looked at some earlier point in its lineage. */
const seedRow = async (overrides: Partial<SharedModel> & { name: string; model: string }) => {
  const row: SharedModel = { ...defaultModelOpus5, ...overrides }
  await getDb()
    .insert(modelsTable)
    .values({ ...row, defaultHash: overrides.defaultHash ?? hashModel(row) })
  return row
}

const readRow = async () => getDb().select().from(modelsTable).where(eq(modelsTable.id, defaultModelOpus5.id)).get()

describe('upgradeOpusDefault', () => {
  /**
   * THU-843. The row id is reused across renames, so a device stuck on the
   * original slug shows "Sonnet 4.5" *and* appears to have no Opus — one fault,
   * two symptoms. The repair previously only knew about the 4.8 → 5 hop.
   */
  it('moves a row still stranded on the original sonnet slug up to Opus 5', async () => {
    await seedRow({ name: 'Sonnet 4.5', model: 'sonnet-4.5' })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.model).toBe(defaultModelOpus5.model)
    expect(row?.name).toBe(defaultModelOpus5.name)
  })

  it('still handles the 4.8 hop it was written for', async () => {
    await seedRow({ name: 'Opus 4.8', model: 'opus-4.8' })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.model).toBe(defaultModelOpus5.model)
    expect(row?.name).toBe(defaultModelOpus5.name)
  })

  /** The row originally carried the bare slug as its display name. */
  it('replaces the slug-shaped legacy name too', async () => {
    await seedRow({ name: 'sonnet-4.5', model: 'sonnet-4.5' })

    await upgradeOpusDefault(getDb())

    expect((await readRow())?.name).toBe(defaultModelOpus5.name)
  })

  it('keeps a name the user chose while still moving the slug forward', async () => {
    await seedRow({ name: 'My favourite model', model: 'sonnet-4.5' })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.model).toBe(defaultModelOpus5.model)
    expect(row?.name).toBe('My favourite model')
  })

  /**
   * The reason the legacy slugs are enumerated rather than treated as
   * "anything that isn't opus-5": this row is user-editable.
   */
  it('leaves a row the user repointed at their own model alone', async () => {
    await seedRow({ name: 'My local llama', model: 'llama-3.3-70b' })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.model).toBe('llama-3.3-70b')
    expect(row?.name).toBe('My local llama')
  })

  it('does nothing to a row already on the current slug', async () => {
    const seeded = await seedRow({ name: defaultModelOpus5.name, model: defaultModelOpus5.model })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.model).toBe(defaultModelOpus5.model)
    expect(row?.defaultHash).toBe(hashModel(seeded))
  })

  it('does not resurrect a soft-deleted row', async () => {
    await seedRow({ name: 'Sonnet 4.5', model: 'sonnet-4.5', deletedAt: '2026-01-01T00:00:00.000Z' })

    await upgradeOpusDefault(getDb())

    expect((await readRow())?.model).toBe('sonnet-4.5')
  })

  /** An untouched row stays adoptable by reconciliation after the rename. */
  it('restamps the default hash when the row was unmodified', async () => {
    await seedRow({ name: 'Sonnet 4.5', model: 'sonnet-4.5' })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.defaultHash).toBe(hashModel(row as SharedModel))
  })

  /** A modified row keeps its stale hash, so it stays flagged as user-owned. */
  it('leaves the default hash alone when the row was modified', async () => {
    await seedRow({ name: 'Sonnet 4.5', model: 'sonnet-4.5', defaultHash: 'user-edited-since' })

    await upgradeOpusDefault(getDb())

    const row = await readRow()
    expect(row?.model).toBe(defaultModelOpus5.model)
    expect(row?.defaultHash).toBe('user-edited-since')
  })
})

describe('normalizeOpusDefault', () => {
  /** Stops a stale defaults payload restoring a retired alias under this id. */
  it('rewrites a legacy payload entry to the current identity', () => {
    const normalized = normalizeOpusDefault({ ...defaultModelOpus5, name: 'Sonnet 4.5', model: 'sonnet-4.5' })

    expect(normalized.model).toBe(defaultModelOpus5.model)
    expect(normalized.name).toBe(defaultModelOpus5.name)
  })

  it('leaves a payload entry for a different model untouched', () => {
    const other: SharedModel = { ...defaultModelOpus5, id: 'some-other-id', name: 'Other', model: 'sonnet-4.5' }

    expect(normalizeOpusDefault(other)).toEqual(other)
  })
})
