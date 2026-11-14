/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { auditEvent, user } from '@/db/schema'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { clientAuditEventBudget } from './client-routes'

describe('POST /v1/audit/client-events', () => {
  let harness: TestAppHandle
  let userId: string

  beforeEach(async () => {
    harness = await createTestApp()
    ;[{ id: userId }] = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, harness.email))
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  const report = (body: unknown, headers = authHeaders(harness.bearerToken)) =>
    harness.app.handle(
      new Request('http://localhost/v1/audit/client-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )

  const reported = () =>
    harness.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorId, userId), eq(auditEvent.reportSource, 'client')))

  const mcpAdded = {
    action: 'user_connection.added',
    target: { type: 'mcp_server', id: 'mcp-1' },
    provider: 'custom',
    authMethod: 'oauth',
  }

  it('stores a report as client-reported, with the actor and time the server knows', async () => {
    const res = await report(mcpAdded)

    expect(res.status).toBe(204)
    expect(await reported()).toMatchObject([
      {
        action: 'user_connection.added',
        outcome: 'success',
        actorType: 'user',
        targetType: 'mcp_server',
        targetId: 'mcp-1',
        reportSource: 'client',
        metadata: { provider: 'custom', authMethod: 'oauth' },
      },
    ])
  })

  it('refuses anything but the listed actions, targets and id-shaped values', async () => {
    const refused = [
      { ...mcpAdded, action: 'member.role_granted' },
      { ...mcpAdded, target: { type: 'user', id: 'u' } },
      { ...mcpAdded, target: { type: 'mcp_server', id: 'https://mcp.example.com/?token=secret' } },
      { ...mcpAdded, provider: 'sk-live key' },
    ]
    for (const body of refused) {
      expect((await report(body)).status).toBe(422)
    }
    expect(await reported()).toEqual([])
  })

  it('stores nothing a report adds beyond its schema', async () => {
    await report({ ...mcpAdded, credential: 'secret-value', target: { ...mcpAdded.target, token: 'secret-value' } })

    expect(await reported()).toHaveLength(1)
    expect(JSON.stringify(await reported())).not.toContain('secret-value')
  })

  it('needs a session', async () => {
    expect((await report(mcpAdded, {})).status).toBe(401)
  })

  it('drops reports from anonymous users, who are not members', async () => {
    await harness.db.update(user).set({ isAnonymous: true }).where(eq(user.id, userId))

    expect((await report(mcpAdded)).status).toBe(204)
    expect(await reported()).toEqual([])
  })

  it("caps one user's reports per hour", async () => {
    for (let index = 0; index < clientAuditEventBudget.max; index++) {
      expect((await report(mcpAdded)).status).toBe(204)
    }

    expect((await report(mcpAdded)).status).toBe(429)
    expect(await reported()).toHaveLength(clientAuditEventBudget.max)
  })
})
