/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { cloudAgentScope } from '@shared/cloud-agent/contracts'
import { encryptScopedJson } from '@shared/cloud-agent/crypto'
import { createMockAuth, mockAuthUnauthenticated } from '../test-utils/mock-auth'
import { createCloudAgentRoutes } from './routes'
import { createServiceFixture } from './service-test-fixture'
import { devicesTable } from '../db/powersync-schema'

/** Send commands through Elysia's actual auth, route validation and error mapping. */
const request = (path: string, body?: unknown): Request =>
  new Request(`http://localhost/cloud-agents${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

/** A bound trusted-device session reaches the same mutation guard as the browser. */
const authorizedApp = async (f: Awaited<ReturnType<typeof createServiceFixture>>, owner = f) => {
  const deviceId = crypto.randomUUID()
  await f.database
    .insert(devicesTable)
    .values({ id: deviceId, userId: owner.ownerId, trusted: true, deviceType: 'normal' })
  const base = createMockAuth(owner.ownerId)
  const api: typeof base.api = Object.create(base.api)
  const auth: typeof base = Object.create(base)
  Object.defineProperty(auth, 'api', { value: api })
  Object.defineProperty(api, 'getSession', {
    value: async () => ({ user: { id: owner.ownerId }, session: { deviceId } }),
  })
  const app = createCloudAgentRoutes(auth, f.service, null)
  return {
    handle: (input: Request) => {
      const headers = new Headers(input.headers)
      headers.set('x-device-id', deviceId)
      return app.handle(new Request(input, { headers }))
    },
  }
}

describe('cloud agent API boundary', () => {
  it('requires a session for reads, commands, approvals, and artifact access', async () => {
    const f = await createServiceFixture()
    const app = createCloudAgentRoutes(mockAuthUnauthenticated, f.service, null)
    for (const input of [
      request('/capabilities'),
      request('/identity'),
      request('/agents'),
      request('/connections'),
      request('/artifacts'),
      request(`/conversations/${f.conversation.id}`),
      request(`/conversations/${f.conversation.id}/stop`, {}),
      request('/approvals/not-owned/decide', { decision: 'approved' }),
    ]) {
      const response = await app.handle(input)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ code: 'UNAUTHENTICATED' })
    }
  })

  it('does not expose another account through guessed resource IDs', async () => {
    const f = await createServiceFixture()
    const stranger = await createServiceFixture()
    const app = await authorizedApp(f, stranger)
    for (const input of [
      request(`/agents/${f.agentId}`),
      request(`/agents/${f.agentId}/conversations`),
      request(`/conversations/${f.conversation.id}`),
      request(`/conversations/${f.conversation.id}/stop`, {}),
      request(`/conversations/${f.conversation.id}/messages`, await f.submission()),
    ]) {
      const response = await app.handle(input)
      expect(response.status).toBe(404)
    }
    const listing = await (await app.handle(request('/agents'))).text()
    expect(listing).not.toContain(f.agentId)
    expect(listing).toContain(stranger.agentId)
  })

  it('returns encrypted config and owner envelopes without runtime envelopes or plaintext', async () => {
    const f = await createServiceFixture()
    const app = await authorizedApp(f)
    const response = await app.handle(request(`/agents/${f.agentId}`))
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('ownerKeyEnvelope')
    expect(body).not.toContain('runtimeKeyEnvelope')
    expect(body).not.toContain(f.config.instructions)
    expect(body).not.toContain(f.runtimeIdentity.ecdhPrivateKey)
  })

  it('rejects mismatched resource identities and unknown plaintext fields', async () => {
    const f = await createServiceFixture()
    const app = await authorizedApp(f)
    const mismatch = await app.handle(request(`/agents/${crypto.randomUUID()}`, f.input))
    expect(mismatch.status).toBe(422)
    expect(await mismatch.json()).toEqual({ error: 'resource_id_mismatch' })
    const plaintext = await app.handle(
      request(`/conversations/${f.conversation.id}/messages`, {
        ...(await f.submission()),
        prompt: 'This should never be accepted',
      }),
    )
    expect(plaintext.status).toBe(422)
    expect(await plaintext.json()).toEqual({ error: 'invalid_cloud_request' })
  })

  it('acknowledges caller-named conversation creation idempotently', async () => {
    const f = await createServiceFixture()
    const app = await authorizedApp(f)
    const id = crypto.randomUUID()
    const path = '/agents/' + f.agentId + '/conversations'
    const first = await app.handle(request(path, { id }))
    expect(first.status).toBe(200)
    const firstBody: unknown = await first.json()
    expect(firstBody).toMatchObject({ id, agentId: f.agentId })
    const retried = await app.handle(request(path, { id }))
    expect(retried.status).toBe(200)
    expect(await retried.json()).toEqual(firstBody)
    const invalid = await app.handle(request(path, { id: 'not-a-uuid' }))
    expect(invalid.status).toBe(422)
    expect((await f.service.conversations(f.ownerId, f.agentId)).conversations).toHaveLength(2)
  })

  it('creates and updates encrypted schedules through the stable schedule-ID route', async () => {
    const f = await createServiceFixture()
    const app = await authorizedApp(f)
    const id = crypto.randomUUID()
    const input = {
      id,
      agentId: f.agentId,
      expectedVersion: 0,
      enabled: true,
      keyEpoch: 1,
      config: await encryptScopedJson(
        {
          name: 'Periodic',
          prompt: 'Private scheduled prompt',
          timezone: 'UTC',
          cadence: { type: 'interval', minutes: 30 },
        },
        f.key,
        {
          ownerId: f.ownerId,
          scopeId: cloudAgentScope(f.agentId),
          keyEpoch: 1,
          recordId: id,
          purpose: 'schedule',
        },
      ),
    }
    const path = '/agents/' + f.agentId + '/schedules/' + id
    const created = await app.handle(request(path, input))
    expect(created.status).toBe(200)
    const createdBody: unknown = await created.json()
    expect(createdBody).toMatchObject({ id, version: 1, enabled: true })
    expect(JSON.stringify(createdBody)).not.toContain('Private scheduled prompt')
    expect(await (await app.handle(request(path, input))).json()).toEqual(createdBody)
    const changed = { ...input, expectedVersion: 1, enabled: false }
    const updated = await app.handle(request(path, changed))
    expect(updated.status).toBe(200)
    const updatedBody: unknown = await updated.json()
    expect(updatedBody).toMatchObject({ id, version: 2, enabled: false, nextRunAt: null })
    expect(await (await app.handle(request(path, changed))).json()).toEqual(updatedBody)
    const mismatch = await app.handle(request('/agents/' + f.agentId + '/schedules/' + crypto.randomUUID(), input))
    expect(mismatch.status).toBe(422)
    expect((await f.service.schedules(f.ownerId, f.agentId)).schedules).toHaveLength(1)
  })

  it('admits encrypted commands idempotently and exposes their durable acknowledgement', async () => {
    const f = await createServiceFixture()
    const app = await authorizedApp(f)
    const input = await f.submission()
    const first = await app.handle(request(`/conversations/${f.conversation.id}/messages`, input))
    expect(first.status).toBe(200)
    const firstBody: unknown = await first.json()
    expect(await (await app.handle(request(`/conversations/${f.conversation.id}/messages`, input))).json()).toEqual(
      firstBody,
    )
    const state = await app.handle(request(`/conversations/${f.conversation.id}`))
    expect(state.status).toBe(200)
    const body = await state.text()
    expect(body).toContain(input.commandId)
    expect(body).toContain('queued')
    expect(body).not.toContain('Private prompt')
  })

  it('maps malformed JSON to a client error without revealing parser details', async () => {
    const f = await createServiceFixture()
    const app = await authorizedApp(f)
    const response = await app.handle(
      new Request('http://localhost/cloud-agents/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'invalid_cloud_request' })
  })
})
