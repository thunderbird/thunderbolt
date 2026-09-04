/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestDb } from '@/test-utils/db'
import { defaultModels } from '@shared/defaults/models'
import { managedGlmIdentity } from '@shared/inference-usage'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { managedDirectRuntimes, resolveManagedDirectRuntime } from './managed-models'
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
  })

  it('uses GLM as the only confidential policy and receipt identity', async () => {
    const confidentialModels = defaultModels.filter(({ isConfidential }) => isConfidential === 1)

    expect(confidentialModels.map(({ model }) => model)).toEqual([managedGlmIdentity.model])
    expect(await loadInferencePrice(database, managedGlmIdentity)).not.toBeNull()
  })
})
