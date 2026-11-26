/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  auditEvent,
  identityConnection,
  localGroup,
  memberRoleGrant,
  orgMembership,
  organization,
  user,
} from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { adminDenialAuditBudget } from '../admin-macro'
import { getCurrentOrganizationId } from '../current-organization'
import { scimAuditEvent } from '../scim/actor'
import type { AuditAction } from './events'
import { insertAuditEvent } from './write'

type AuditPage = {
  events: { id: string; action: string; orgId: string; actorLabel: string | null; targetLabel: string | null }[]
  nextCursor: string | null
}

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

  it("names each event's actor and target, and leaves a missing, non-member or other org's one unnamed", async () => {
    await makeAdmin()
    const orgId = getCurrentOrganizationId()
    await harness.db.update(user).set({ name: 'Ada Admin' }).where(eq(user.id, userId))
    await harness.db.insert(localGroup).values({ id: 'ops', orgId, name: 'Ops' })
    await harness.db
      .insert(identityConnection)
      .values({ id: 'okta', orgId, name: 'Okta', scimConnectionId: 'scim-okta' })
    await harness.db.insert(organization).values({ id: 'other-org', name: 'Other', slug: 'other-org' })
    await harness.db.insert(localGroup).values({ id: 'theirs', orgId: 'other-org', name: 'Not yours' })
    const write = (actor: { type: 'user'; id: string }, target: { type: string; id: string }) =>
      insertAuditEvent(harness.db, { action: 'local_group.updated', outcome: 'success', actor, target })
    await write({ type: 'user', id: userId }, { type: 'local_group', id: 'ops' })
    // Through the SCIM event writer, so the actor id is the one real SCIM events carry.
    await insertAuditEvent(
      harness.db,
      scimAuditEvent('local_group.updated', {
        identityConnectionId: 'okta',
        credentialId: null,
        target: { type: 'identity_connection', id: 'okta' },
      }),
    )
    await write({ type: 'user', id: userId }, { type: 'local_group', id: 'gone' })
    await write({ type: 'user', id: userId }, { type: 'local_group', id: 'theirs' })
    const [outsider] = await harness.db
      .insert(user)
      .values({ id: 'outsider', name: 'Not a member', email: 'outsider@elsewhere.test', emailVerified: true })
      .returning()
    await write({ type: 'user', id: outsider.id }, { type: 'user', id: outsider.id })

    const page = (await (await list('?action=local_group.updated')).json()) as AuditPage
    // Written in the same millisecond, the events' order is not theirs to keep.
    const labels = page.events.map(({ actorLabel, targetLabel }) => `${actorLabel} → ${targetLabel}`).sort()
    expect(labels).toEqual(['Ada Admin → Ops', 'Ada Admin → null', 'Ada Admin → null', 'Okta → Okta', 'null → null'])
  })

  describe('q', () => {
    const write = (action: AuditAction, actor: { type: 'user'; id: string }, target: { type: string; id: string }) =>
      insertAuditEvent(harness.db, { action, outcome: 'success', actor, target })
    const seededActions: string[] = ['local_group.updated', 'local_group.created', 'connection.updated']
    // Only the events seeded here: signing the harness in records its own.
    const search = async (query: string) => {
      const page = (await (await list(query)).json()) as AuditPage
      return page.events
        .filter((event) => seededActions.includes(event.action))
        .map(({ action, actorLabel, targetLabel }) => `${action}: ${actorLabel} → ${targetLabel}`)
        .sort()
    }

    beforeEach(async () => {
      await makeAdmin()
      const orgId = getCurrentOrganizationId()
      await harness.db.update(user).set({ name: 'Ada Admin' }).where(eq(user.id, userId))
      await harness.db.insert(localGroup).values([
        { id: 'ops', orgId, name: 'Ops' },
        { id: 'pct', orgId, name: '100% Club' },
      ])
      await harness.db
        .insert(identityConnection)
        .values({ id: 'okta', orgId, name: 'Okta Prod', scimConnectionId: 'scim-okta' })
      const [outsider] = await harness.db
        .insert(user)
        .values({ id: 'outsider', name: 'Ada Outsider', email: 'outsider@elsewhere.test', emailVerified: true })
        .returning()
      await write('local_group.updated', { type: 'user', id: userId }, { type: 'local_group', id: 'ops' })
      await write('local_group.created', { type: 'user', id: userId }, { type: 'local_group', id: 'pct' })
      await write('connection.updated', { type: 'user', id: userId }, { type: 'identity_connection', id: 'okta' })
      await write('local_group.updated', { type: 'user', id: outsider.id }, { type: 'user', id: outsider.id })
    })

    it("matches the actor's name or email, case-insensitively, and only a member's", async () => {
      expect(await search('?q=ada%20ADMIN')).toEqual([
        'connection.updated: Ada Admin → Okta Prod',
        'local_group.created: Ada Admin → 100% Club',
        'local_group.updated: Ada Admin → Ops',
      ])
      expect(await search(`?q=${encodeURIComponent(harness.email.toUpperCase())}`)).toHaveLength(3)
      expect(await search('?q=outsider')).toEqual([])
    })

    it("matches a connection's name as the target", async () => {
      expect(await search('?q=okta')).toEqual(['connection.updated: Ada Admin → Okta Prod'])
    })

    it('matches % and _ literally', async () => {
      expect(await search(`?q=${encodeURIComponent('%')}`)).toEqual(['local_group.created: Ada Admin → 100% Club'])
      expect(await search(`?q=${encodeURIComponent('O_s')}`)).toEqual([])
    })

    it('narrows the other filters, and pages', async () => {
      expect(await search('?q=ada&action=local_group.updated')).toEqual(['local_group.updated: Ada Admin → Ops'])

      const all = (await (await list('?q=ada')).json()) as AuditPage
      const first = (await (await list('?q=ada&limit=2')).json()) as AuditPage
      const rest = (await (await list(`?q=ada&cursor=${first.nextCursor}`)).json()) as AuditPage
      expect(first.events).toHaveLength(2)
      expect([...first.events, ...rest.events].map((event) => event.id)).toEqual(all.events.map((event) => event.id))
    })
  })

  it('rejects a page larger than the maximum and a malformed cursor', async () => {
    await makeAdmin()
    expect((await list('?limit=101')).status).toBe(422)
    expect((await list('?cursor=not-a-cursor')).status).toBe(400)
  })
})

describe('GET /v1/admin/audit-events/:eventId', () => {
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

  const get = (eventId: string, headers = authHeaders(harness.bearerToken)) =>
    harness.app.handle(new Request(`http://localhost/v1/admin/audit-events/${eventId}`, { headers }))

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

  it('refuses a member who is not an admin', async () => {
    const res = await get('any-event')

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'ADMIN_REQUIRED' })
  })

  it("returns one of the org's events, its actor and target named as the list names them", async () => {
    await makeAdmin()
    const orgId = getCurrentOrganizationId()
    await harness.db.update(user).set({ name: 'Ada Admin' }).where(eq(user.id, userId))
    await harness.db.insert(localGroup).values({ id: 'ops', orgId, name: 'Ops' })
    await insertAuditEvent(harness.db, {
      action: 'local_group.updated',
      outcome: 'success',
      actor: { type: 'user', id: userId },
      target: { type: 'local_group', id: 'ops' },
      changes: { name: { from: 'Opps', to: 'Ops' } },
    })
    const [{ id }] = await harness.db
      .select({ id: auditEvent.id })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'local_group.updated'), eq(auditEvent.targetId, 'ops')))

    const res = await get(id)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id,
      orgId,
      action: 'local_group.updated',
      actorId: userId,
      actorLabel: 'Ada Admin',
      targetType: 'local_group',
      targetId: 'ops',
      targetLabel: 'Ops',
      changes: { name: { from: 'Opps', to: 'Ops' } },
    })
  })

  it("answers 404 for another org's event and for an unknown id", async () => {
    await makeAdmin()
    await harness.db.insert(organization).values({ id: 'other-org', name: 'Other', slug: 'other-org' })
    const theirs = crypto.randomUUID()
    await harness.db.insert(auditEvent).values({
      id: theirs,
      orgId: 'other-org',
      action: 'local_group.created',
      outcome: 'success',
      actorType: 'system',
    })

    for (const eventId of [theirs, 'no-such-event']) {
      const res = await get(eventId)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ code: 'AUDIT_EVENT_NOT_FOUND' })
    }
  })
})
