/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { workspacesTable } from '@/db/tables'
import { getAllModels } from '@/dal/models'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { computePersonalWorkspaceId } from '@shared/workspaces'
import { runPostAuthBootstrap, resetPostAuthBootstrap } from './post-auth-bootstrap'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})
afterAll(async () => {
  await teardownTestDatabase()
})

describe('runPostAuthBootstrap — standalone', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    resetPostAuthBootstrap()
    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })
  })

  it('creates the personal workspace for the local user and seeds default models', async () => {
    const localUserId = uuidv7()
    await runPostAuthBootstrap({ kind: 'standalone', userId: localUserId })

    const personalWorkspaceId = computePersonalWorkspaceId(localUserId)
    const workspace = await getDb()
      .select()
      .from(workspacesTable)
      .where(and(eq(workspacesTable.id, personalWorkspaceId), eq(workspacesTable.ownerUserId, localUserId)))
      .get()
    expect(workspace).toBeDefined()

    const models = await getAllModels(getDb(), personalWorkspaceId)
    expect(models.length).toBeGreaterThan(0)
  })

  it('is idempotent — a second run does not throw or duplicate the workspace', async () => {
    const localUserId = uuidv7()
    await runPostAuthBootstrap({ kind: 'standalone', userId: localUserId })
    resetPostAuthBootstrap()
    await runPostAuthBootstrap({ kind: 'standalone', userId: localUserId })

    const personalWorkspaceId = computePersonalWorkspaceId(localUserId)
    const rows = await getDb().select().from(workspacesTable).where(eq(workspacesTable.id, personalWorkspaceId))
    expect(rows).toHaveLength(1)
  })
})
