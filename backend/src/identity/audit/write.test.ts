/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { auditEvent, localGroup } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getCurrentOrganizationId } from '../current-organization'
import { runWithAuditRequestId } from './request-context'
import {
  type AuditEventInput,
  createAuditBudget,
  createAuditEvent,
  insertAuditEvent,
  recordFailedAttempt,
} from './write'

const groupCreated = (groupId: string): AuditEventInput => ({
  action: 'local_group.created',
  outcome: 'success',
  actor: { type: 'user', id: 'admin-1' },
  target: { type: 'local_group', id: groupId },
  changes: { name: 'Finance' },
})

describe('audit writers', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
  })

  afterEach(async () => {
    await cleanup()
  })

  const eventsFor = (groupId: string) => db.select().from(auditEvent).where(eq(auditEvent.targetId, groupId))
  const groupExists = async (groupId: string) => (await db.$count(localGroup, eq(localGroup.id, groupId))) > 0

  it('commits an event with the change it records', async () => {
    const groupId = crypto.randomUUID()
    await db.transaction(async (tx) => {
      await tx.insert(localGroup).values({ id: groupId, orgId: getCurrentOrganizationId(), name: 'Finance' })
      await insertAuditEvent(tx, groupCreated(groupId))
    })

    expect(await groupExists(groupId)).toBe(true)
    expect(await eventsFor(groupId)).toMatchObject([
      {
        orgId: getCurrentOrganizationId(),
        action: 'local_group.created',
        outcome: 'success',
        actorType: 'user',
        actorId: 'admin-1',
        targetType: 'local_group',
        reportSource: 'server',
        changes: { name: 'Finance' },
      },
    ])
  })

  it('rolls an event back with its change, with Drizzle and with the auth adapter', async () => {
    const drizzleGroup = crypto.randomUUID()
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(localGroup).values({ id: drizzleGroup, orgId: getCurrentOrganizationId(), name: 'Ops' })
        await insertAuditEvent(tx, groupCreated(drizzleGroup))
        throw new Error('change failed')
      }),
    ).rejects.toThrow('change failed')

    const adapter = (await createAuth(db).$context).adapter
    const adapterGroup = crypto.randomUUID()
    await expect(
      runWithTransaction(adapter, async () => {
        const tx = await getCurrentAdapter(adapter)
        await tx.create({
          model: 'localGroup',
          data: { id: adapterGroup, orgId: getCurrentOrganizationId(), name: 'Sales' },
          forceAllowId: true,
        })
        await createAuditEvent(tx, groupCreated(adapterGroup))
        throw new Error('change failed')
      }),
    ).rejects.toThrow('change failed')

    for (const groupId of [drizzleGroup, adapterGroup]) {
      expect(await groupExists(groupId)).toBe(false)
      expect(await eventsFor(groupId)).toEqual([])
    }
  })

  it('records a failed attempt after its own transaction rolled back', async () => {
    const groupId = crypto.randomUUID()
    await db
      .transaction(async (tx) => {
        await tx.insert(localGroup).values({ id: groupId, orgId: getCurrentOrganizationId(), name: 'Finance' })
        throw new Error('change failed')
      })
      .catch(() => recordFailedAttempt(db, { ...groupCreated(groupId), outcome: 'failure', reason: 'change failed' }))

    expect(await groupExists(groupId)).toBe(false)
    expect(await eventsFor(groupId)).toMatchObject([{ outcome: 'failure', reason: 'change failed' }])
  })

  it("stamps events with the current request's id, and none outside a request", async () => {
    const [inRequest, outside] = [crypto.randomUUID(), crypto.randomUUID()]
    await runWithAuditRequestId(async () => {
      await insertAuditEvent(db, groupCreated(inRequest))
      await createAuditEvent((await createAuth(db).$context).adapter, groupCreated(inRequest))
    }, 'request-1')
    await insertAuditEvent(db, groupCreated(outside))

    expect((await eventsFor(inRequest)).map((row) => row.requestId)).toEqual(['request-1', 'request-1'])
    expect(await eventsFor(outside)).toMatchObject([{ requestId: null }])
  })

  it('lets a key write up to its budget, then refuses it alone', async () => {
    const mayWrite = createAuditBudget(db, 'audit-admin-denied', { max: 2, durationSecs: 60 })

    expect([await mayWrite('user:a'), await mayWrite('user:a'), await mayWrite('user:a')]).toEqual([true, true, false])
    expect(await mayWrite('user:b')).toBe(true)
  })
})
