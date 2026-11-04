/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { cloudConnectionScope } from '@shared/cloud-agent/contracts'
import { encryptScopedJson, generateResourceKey, sealResourceKey } from '@shared/cloud-agent/crypto'
import { getSettings } from '../config/settings'
import { cloudConnections } from '../db/cloud-agent-schema'
import { createRuntimeHost } from './host'
import { createServiceFixture } from './service-test-fixture'

/** Resolve a real encrypted model grant, then exercise its network boundary after authorization changes. */
const fixture = async () => {
  const f = await createServiceFixture()
  const id = crypto.randomUUID()
  const key = await generateResourceKey()
  const scope = { ownerId: f.ownerId, scopeId: cloudConnectionScope(id), keyEpoch: 1 }
  await f.service.saveConnection(f.ownerId, {
    id,
    expectedVersion: 0,
    keyEpoch: 1,
    enabled: true,
    config: await encryptScopedJson(
      {
        name: 'Test model',
        kind: 'model',
        url: 'https://model.example.test/v1',
        authentication: { type: 'bearer', token: 'captured-test-token' },
      },
      key,
      { ...scope, purpose: 'connection-config', recordId: 'config' },
    ),
    ownerKeyEnvelope: await sealResourceKey(key, f.ownerIdentity.publicKey, { ...scope, recipientId: f.ownerId }),
    runtimeKeyEnvelope: await sealResourceKey(key, f.runtimeIdentity.publicKey, {
      ...scope,
      recipientId: f.runtimeIdentity.publicKey.keyId,
    }),
  })
  await f.service.saveAgent(
    f.ownerId,
    await f.agentInput(
      {
        model: {
          ...f.config.model,
          provider: 'openai-compatible',
          connectionId: id,
          inputCostPerMillion: 1,
          outputCostPerMillion: 2,
        },
      },
      1,
    ),
  )
  const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
  const host = createRuntimeHost(f.service, null, getSettings())
  const model = await host.resolveModel(await host.loadRun(run.id))
  return { ...f, id, model }
}

describe('cloud model credential dispatch', () => {
  it('reports unavailable managed model setup as an expected execution failure', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    const host = createRuntimeHost(f.service, null, { ...getSettings(), tinfoilApiKey: '' })
    await expect(host.resolveModel(await host.loadRun(run.id))).rejects.toMatchObject({
      status: 503,
      code: 'managed_model_unavailable',
    })
  })

  it.each([{ credentialVersion: 2 }, { version: 2 }, { enabled: false }])(
    'refuses captured credentials after connection change %j',
    async (change) => {
      const f = await fixture()
      await f.database.update(cloudConnections).set(change).where(eq(cloudConnections.id, f.id))
      // The reserved .test hostname never reaches DNS: the grant must fail before any upstream request.
      await expect(f.model.fetch!('https://model.example.test/v1/chat/completions')).rejects.toMatchObject({
        code: 'enabled' in change ? 'connection_disabled' : 'connection_grant_changed',
      })
    },
  )

  it('refuses credentials after the agent switches away from that model connection', async () => {
    const f = await fixture()
    await f.service.saveAgent(f.ownerId, await f.agentInput({ model: f.config.model }, 2))
    await expect(f.model.fetch!('https://model.example.test/v1/chat/completions')).rejects.toMatchObject({
      code: 'connection_grant_changed',
    })
  })

  it('checks live execution revocation at the network boundary', async () => {
    const f = await fixture()
    await f.service.saveAgent(f.ownerId, { ...(await f.agentInput({}, 2)), enabled: false })
    await expect(f.model.fetch!('https://model.example.test/v1/chat/completions')).rejects.toMatchObject({
      code: 'grant_revoked',
    })
  })
})
