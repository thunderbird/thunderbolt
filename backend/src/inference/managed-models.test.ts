/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestDb } from '@/test-utils/db'
import { defaultModels } from '@shared/defaults/models'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { managedDirectRuntimes, resolveManagedDirectRuntime, resolveConfidentialManagedModel } from './managed-models'
import { loadInferencePrice } from './usage-ledger'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']

describe('managed model backend coverage', () => {
  let database: TestDatabase
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('gives every public direct slug exactly one private runtime with a canonical price', async () => {
    const directSlugs = defaultModels.filter(({ isConfidential }) => isConfidential === 0).map(({ model }) => model)

    expect(new Set(directSlugs).size).toBe(directSlugs.length)
    expect(Object.keys(managedDirectRuntimes)).toEqual(directSlugs)

    for (const runtime of Object.values(managedDirectRuntimes)) {
      expect(
        await loadInferencePrice(database, { provider: runtime.provider, model: runtime.internalName }),
      ).not.toBeNull()
    }
  })

  it('resolves every valid direct slug to its private runtime', () => {
    for (const [slug, runtime] of Object.entries(managedDirectRuntimes)) {
      expect(resolveManagedDirectRuntime(slug)).toBe(runtime)
    }
  })

  it.each(['toString', 'constructor', '__proto__'])('does not resolve prototype-property slug %s', (slug) => {
    expect(resolveManagedDirectRuntime(slug)).toBeUndefined()
    expect(resolveConfidentialManagedModel(slug)).toBeUndefined()
  })

  it('gives every confidential catalog model its canonical price and excludes direct models', async () => {
    const confidentialModels = defaultModels.filter(({ isConfidential }) => isConfidential === 1)

    expect(confidentialModels.map(({ model }) => model)).toEqual(['deepseek-v4-flash', 'glm-5-2'])
    for (const { model } of confidentialModels) {
      const identity = resolveConfidentialManagedModel(model)
      expect(identity).toEqual({ provider: 'tinfoil', model })
      expect(await loadInferencePrice(database, identity!)).not.toBeNull()
      expect(resolveManagedDirectRuntime(model)).toBeUndefined()
    }
    expect(resolveConfidentialManagedModel('opus-5')).toBeUndefined()
    expect(resolveConfidentialManagedModel('unknown')).toBeUndefined()
  })
})
