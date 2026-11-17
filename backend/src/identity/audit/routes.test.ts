/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { auditEvent, memberRoleGrant, orgMembership, organization, user } from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { adminDenialAuditBudget } from '../admin-macro'
import { getCurrentOrganizationId } from '../current-organization'
import { insertAuditEvent } from './write'

type AuditPage = { events: { id: string; action: string; orgId: string }[]; nextCursor: string | null }

describe('GET /v1/admin/audit-events', () => {
  let harness: TestAppHandle
  let userId: string

  beforeEach(async () => {
    harness = await createTestApp()
    const [row] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
    userId = row.id
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const list = (query = '', headers = authHeaders(harness.bearerToken)) =>
    harness.app.handle(new Request(`http://localhost/v1/admin/audit-events${query}`, { headers }))

  const makeAdmin = async () => {
    const [membership] = await harness.db
      .select({ id: orgMembership.id })
      .from(orgMembership)
      .where(eq(orgMembership.userId, userId))
    await harness.db.insert(memberRoleGrant).values({
      id: crypto.randomUUID(),
      orgId: getCurrentOrganizationId(),
      membershipId: membership.id,
      role: 'admin',
      source: 'local',
    })
  }

  const seedEvents = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await insertAuditEvent(harness.db, {
        action: 'local_group.created',
        outcome: 'success',
        actor: { type: 'user', id: userId },
        target: { type: 'local_group', id: `group-${index}` },
      })
    }
  }

  it('answers 401 without a session', async () => {
    expect((await list('', {})).status).toBe(401)
  })

  it('refuses a member who is not an admin, and records the denial', async () => {
    const res = await list()

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'ADMIN_REQUIRED' })
    const denials = await harness.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'admin.access_denied'), eq(auditEvent.actorId, userId)))
    expect(denials).toMatchObject([{ outcome: 'denied', metadata: { method: 'GET', path: '/v1/admin/audit-events' } }])
  })

  const denialsBy = (actorId: string) =>
    harness.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'admin.access_denied'), eq(auditEvent.actorId, actorId)))

  it("caps one caller's recorded denials, while every request still gets its 403", async () => {
    const statuses = []
    for (let attempt = 0; attempt <= adminDenialAuditBudget.max; attempt++) {
      statuses.push((await list()).status)
    }

    expect(statuses.every((status) => status === 403)).toBe(true)
    expect(await denialsBy(userId)).toHaveLength(adminDenialAuditBudget.max)
  })

  it('records no denial for an anonymous caller', async () => {
    await harness.db.update(user).set({ isAnonymous: true }).where(eq(user.id, userId))

    expect((await list()).status).toBe(403)
    expect(await denialsBy(userId)).toEqual([])
  })

  it('names the API key, and its owner, when a key is refused', async () => {
    const created = await harness.app.handle(
      new Request('http://localhost/v1/api/auth/api-key/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(harness.bearerToken) },
        body: JSON.stringify({}),
      }),
    )
    const { id, key } = (await created.json()) as { id: string; key: string }

    expect((await list('', { 'x-api-key': key })).status).toBe(403)
    const denials = await denialsBy(id)
    expect(denials).toMatchObject([{ actorType: 'api_key', metadata: { userId } }])
    expect(JSON.stringify(denials)).not.toContain(key)
  })

  it('pages an admin through the current org’s events, newest first', async () => {
    await makeAdmin()
    await seedEvents(3)
    await harness.db.insert(organization).values({ id: 'other-org', name: 'Other', slug: 'other-org' })
    await harness.db.insert(auditEvent).values({
      id: crypto.randomUUID(),
      orgId: 'other-org',
      action: 'local_group.created',
      outcome: 'success',
      actorType: 'system',
    })

    const first = (await (await list('?action=local_group.created&limit=2')).json()) as AuditPage
    expect(first.events.map((event) => event.orgId)).toEqual([getCurrentOrganizationId(), getCurrentOrganizationId()])
    expect(first.nextCursor).not.toBeNull()

    const second = (await (
      await list(`?action=local_group.created&limit=2&cursor=${first.nextCursor}`)
    ).json()) as AuditPage
    expect(second.events).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(3)
  })

  it('rejects a page larger than the maximum and a malformed cursor', async () => {
    await makeAdmin()
    expect((await list('?limit=101')).status).toBe(422)
    expect((await list('?cursor=not-a-cursor')).status).toBe(400)
  })
})
