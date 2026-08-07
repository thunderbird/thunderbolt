/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getAgentDeployment, recordAgentDeployment, revokeAgentDeployment } from './agent-deployments'

describe('agent-deployments DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const insertUser = async (id: string) => {
    const now = new Date()
    await db.insert(user).values({
      id,
      name: 'Test User',
      email: `${id}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    await insertUser('u1')
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  it('records a deployment retrievable with a null revokedAt', async () => {
    await recordAgentDeployment(db, { deploymentId: 'openclaw:a', userId: 'u1' })
    const row = await getAgentDeployment(db, 'openclaw:a')
    expect(row).toEqual({ userId: 'u1', revokedAt: null })
  })

  it('is idempotent when recording the same deployment twice', async () => {
    await recordAgentDeployment(db, { deploymentId: 'openclaw:a', userId: 'u1' })
    await recordAgentDeployment(db, { deploymentId: 'openclaw:a', userId: 'u1' })
    const row = await getAgentDeployment(db, 'openclaw:a')
    expect(row).toEqual({ userId: 'u1', revokedAt: null })
  })

  it('sets revokedAt on revoke and is a no-op on re-revoke', async () => {
    await recordAgentDeployment(db, { deploymentId: 'openclaw:a', userId: 'u1' })

    const firstRevoke = await revokeAgentDeployment(db, 'openclaw:a')
    expect(firstRevoke).toHaveLength(1)
    expect(firstRevoke[0].revokedAt).toBeInstanceOf(Date)

    const secondRevoke = await revokeAgentDeployment(db, 'openclaw:a')
    expect(secondRevoke).toHaveLength(0)

    const row = await getAgentDeployment(db, 'openclaw:a')
    expect(row?.revokedAt).toBeInstanceOf(Date)
  })

  it('returns null for an unknown deployment', async () => {
    expect(await getAgentDeployment(db, 'openclaw:missing')).toBeNull()
  })
})
