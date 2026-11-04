/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  cloudAgentScope,
  cloudConnectionScope,
  type CloudConnectionConfig,
  type SaveCloudConnection,
} from '@shared/cloud-agent/contracts'
import { decryptScopedJson, encryptScopedJson, generateResourceKey, sealResourceKey } from '@shared/cloud-agent/crypto'
import { user } from '../db/auth-schema'
import { cloudApprovals, cloudAgents, cloudConnections, cloudConversations, cloudRuns } from '../db/cloud-agent-schema'
import * as schema from '../db/schema'
import { createServiceFixture, saveFixtureConnection } from './service-test-fixture'

/** Wait for the durable approval row, without guessing how quickly the database handles encryption. */
const waitForApproval = async (f: Awaited<ReturnType<typeof createServiceFixture>>, id: string) => {
  const deadline = Date.now() + 3000
  for (;;) {
    const [row] = await f.database.select().from(cloudApprovals).where(eq(cloudApprovals.id, id))
    if (row) {
      return row
    }
    if (Date.now() > deadline) {
      throw new Error('Approval was not persisted')
    }
    await Bun.sleep(10)
  }
}

describe('cloud agent service authorization and durable commands', () => {
  it('persists the ordered model list and resolves the first model for cloud execution', async () => {
    const f = await createServiceFixture()
    const models = [
      { localModelId: 'managed', name: 'Cloud default', model: f.config.model },
      { localModelId: 'local', name: 'Local alternative', model: null },
    ]
    await f.service.saveAgent(
      f.ownerId,
      await f.agentInput({ models, model: null, modelOrder: ['disabled', 'managed', 'local'] }, 1),
    )
    const saved = await f.service.openAgent(await f.service.getAgent(f.ownerId, f.agentId))
    expect(saved.config.models).toEqual(models)
    expect(saved.config.modelOrder).toEqual(['disabled', 'managed', 'local'])
    expect(saved.config.model).toEqual(f.config.model)
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    expect((await f.service.loadRun(run.id)).config.model).toEqual(f.config.model)
  })

  it('saves a portable local model and disabled MCP selection without allowing a new cloud run', async () => {
    const f = await createServiceFixture()
    const connection = await saveFixtureConnection(f, {}, false)
    const original = await f.submission()
    const existing = await f.service.submit(f.ownerId, f.conversation.id, original)
    await f.service.saveAgent(
      f.ownerId,
      await f.agentInput(
        {
          model: null,
          localModelId: 'local-model',
          connectionIds: [connection.id],
          mcpServers: [{ sourceId: 'local-mcp', name: 'Local tools' }],
        },
        1,
      ),
    )
    const saved = await f.service.openAgent(await f.service.getAgent(f.ownerId, f.agentId))
    expect(saved.config.model).toBeNull()
    expect(saved.config.localModelId).toBe('local-model')
    expect(saved.config.mcpServers).toEqual([{ sourceId: 'local-mcp', name: 'Local tools' }])
    expect((await f.service.submit(f.ownerId, f.conversation.id, original)).id).toBe(existing.id)
    expect((await f.service.loadRun(existing.id)).config.model).toEqual(f.config.model)
    await expect(f.service.submit(f.ownerId, f.conversation.id, await f.submission())).rejects.toMatchObject({
      code: 'cloud_model_unavailable',
    })
  })

  it('accepts unlimited run limits and binds approval choice to the encrypted command', async () => {
    const f = await createServiceFixture()
    await f.service.saveAgent(f.ownerId, await f.agentInput({ maxSteps: null, maxRunCostUsd: null }, 1))
    const command = await f.submission('A chat task', crypto.randomUUID(), 'full-access')
    const run = await f.service.submit(f.ownerId, f.conversation.id, command)
    const loaded = await f.service.loadRun(run.id)
    expect(loaded.config.maxSteps).toBeNull()
    expect(loaded.config.maxRunCostUsd).toBeNull()
    expect(loaded.config.approvalMode).toBe('full-access')
    await f.service.beforeTool(run.id, 'allowed', 'read', {})
    const changed = await f.submission('A chat task', command.commandId, 'ask')
    await expect(f.service.submit(f.ownerId, f.conversation.id, changed)).rejects.toMatchObject({
      code: 'command_payload_conflict',
    })
  })

  it('requires approval when a chat chooses ask even for a legacy full-access agent', async () => {
    const f = await createServiceFixture({ approvalMode: 'full-access' })
    const run = await f.service.submit(
      f.ownerId,
      f.conversation.id,
      await f.submission('Ask first', crypto.randomUUID(), 'ask'),
    )
    const abort = new AbortController()
    const pending = f.service.beforeTool(run.id, 'ask-chat', 'read', {}, abort.signal)
    await waitForApproval(f, `${run.id}:ask-chat`)
    await f.service.decide(f.ownerId, `${run.id}:ask-chat`, 'approved')
    await pending
    expect((await f.service.loadRun(run.id)).config.approvalMode).toBe('ask')
  })

  it('preserves refreshed OAuth for metadata edits but permits explicit replacement with none or bearer', async () => {
    const f = await createServiceFixture()
    const id = crypto.randomUUID()
    const key = await generateResourceKey()
    const scope = { ownerId: f.ownerId, scopeId: cloudConnectionScope(id), keyEpoch: 1 }
    const context = { ...scope, recordId: 'config', purpose: 'connection-config' }
    const authentication: CloudConnectionConfig['authentication'] = {
      type: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      issuer: 'https://issuer.example.com',
      tokenEndpoint: 'https://issuer.example.com/token',
      clientId: 'cloud-client',
      resource: 'https://tools.example.com/mcp',
    }
    const config: CloudConnectionConfig = {
      name: 'Tools',
      kind: 'mcp',
      url: 'https://tools.example.com/mcp',
      authentication,
    }
    const ownerKeyEnvelope = await sealResourceKey(key, f.ownerIdentity.publicKey, { ...scope, recipientId: f.ownerId })
    const runtimeKeyEnvelope = await sealResourceKey(key, f.runtimeIdentity.publicKey, {
      ...scope,
      recipientId: f.runtimeIdentity.publicKey.keyId,
    })
    const input = async (value: CloudConnectionConfig, expectedVersion: number): Promise<SaveCloudConnection> => ({
      id,
      expectedVersion,
      keyEpoch: 1,
      enabled: true,
      ownerKeyEnvelope,
      runtimeKeyEnvelope,
      config: await encryptScopedJson(value, key, context),
    })
    await f.service.saveConnection(f.ownerId, await input(config, 0))
    await f.database
      .update(cloudConnections)
      .set({
        config: await encryptScopedJson(
          {
            ...config,
            authentication: { ...authentication, accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
          },
          key,
          context,
        ),
        credentialVersion: 2,
      })
      .where(eq(cloudConnections.id, id))
    await f.service.saveConnection(
      f.ownerId,
      await input({ ...config, libraryRef: { kind: 'mcp', id: 'library-item' } }, 1),
    )
    expect(
      (await f.service.openConnection(await f.service.getConnection(f.ownerId, id))).config.authentication,
    ).toMatchObject({ type: 'oauth', accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
    await f.service.saveConnection(f.ownerId, await input({ ...config, authentication: { type: 'none' } }, 2))
    expect(
      (await f.service.openConnection(await f.service.getConnection(f.ownerId, id))).config.authentication,
    ).toEqual({ type: 'none' })
    await f.service.saveConnection(
      f.ownerId,
      await input({ ...config, authentication: { type: 'bearer', token: 'new-explicit-token' } }, 3),
    )
    expect(
      (await f.service.openConnection(await f.service.getConnection(f.ownerId, id))).config.authentication,
    ).toEqual({ type: 'bearer', token: 'new-explicit-token' })
  })

  it('denies anonymous admission and stops execution if an existing owner is no longer eligible', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    await f.database.update(user).set({ isAnonymous: true }).where(eq(user.id, f.ownerId))
    await expect(f.service.submit(f.ownerId, f.conversation.id, await f.submission())).rejects.toMatchObject({
      code: 'cloud_account_required',
    })
    await expect(f.service.checkExecution(run.id)).rejects.toMatchObject({ code: 'cloud_account_required' })
  })

  it('returns database instants that parse identically in different client timezones', async () => {
    const f = await createServiceFixture()
    const instant = '2026-10-23T04:24:00.000Z'
    await f.database
      .update(cloudAgents)
      .set({ createdAt: instant, updatedAt: instant })
      .where(eq(cloudAgents.id, f.agentId))
    const record = await f.service.agent(f.ownerId, f.agentId)
    for (const timezone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      const parsed = Bun.spawnSync(
        [process.execPath, '-e', 'process.stdout.write(String(Date.parse(process.argv[1])))', record.createdAt],
        {
          env: { ...process.env, TZ: timezone },
        },
      )
      expect(parsed.exitCode).toBe(0)
      expect(Number(new TextDecoder().decode(parsed.stdout))).toBe(Date.parse(instant))
    }
  })

  it('creates a caller-named conversation once and rejects changed ownership or agent bindings', async () => {
    const f = await createServiceFixture()
    const id = crypto.randomUUID()
    const [first, retried] = await Promise.all([
      f.service.createConversation(f.ownerId, f.agentId, id),
      f.service.createConversation(f.ownerId, f.agentId, id),
    ])
    expect(first.id).toBe(id)
    expect(retried).toEqual(first)
    expect(await f.database.select().from(cloudConversations).where(eq(cloudConversations.id, id))).toHaveLength(1)
    const stranger = await createServiceFixture()
    await expect(stranger.service.createConversation(stranger.ownerId, stranger.agentId, id)).rejects.toMatchObject({
      code: 'conversation_id_conflict',
    })
    const anotherAgentId = crypto.randomUUID()
    await f.database
      .insert(cloudAgents)
      .values({ ...(await f.service.getAgent(f.ownerId, f.agentId)), id: anotherAgentId })
    await expect(f.service.createConversation(f.ownerId, anotherAgentId, id)).rejects.toMatchObject({
      code: 'conversation_id_conflict',
    })
    await f.database
      .update(cloudConversations)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(cloudConversations.id, id))
    await expect(f.service.createConversation(f.ownerId, f.agentId, id)).rejects.toMatchObject({
      code: 'conversation_id_conflict',
    })
  })

  it('keeps records and indirect conversation operations within their owner', async () => {
    const f = await createServiceFixture()
    const stranger = crypto.randomUUID()
    await expect(f.service.agent(stranger, f.agentId)).rejects.toMatchObject({ code: 'agent_not_found' })
    await expect(f.service.createConversation(stranger, f.agentId)).rejects.toMatchObject({ code: 'agent_not_found' })
    await expect(f.service.state(stranger, f.conversation.id)).rejects.toMatchObject({ code: 'conversation_not_found' })
    await expect(f.service.stop(stranger, f.conversation.id)).rejects.toMatchObject({ code: 'conversation_not_found' })
    await expect(f.service.submit(stranger, f.conversation.id, await f.submission())).rejects.toMatchObject({
      code: 'conversation_not_found',
    })
    expect((await f.service.agents(stranger)).agents).toEqual([])
    expect(JSON.stringify(await f.service.agent(f.ownerId, f.agentId))).not.toContain('runtimeKeyEnvelope')
    expect(JSON.stringify(await f.service.agent(f.ownerId, f.agentId))).not.toContain(f.config.instructions)
  })

  it('rejects a recovery recipient whose key bytes differ from the registered owner identity', async () => {
    const f = await createServiceFixture()
    const substituted = { ...f.runtimeIdentity.publicKey, keyId: f.ownerIdentity.publicKey.keyId }
    await expect(
      f.service.saveAgent(f.ownerId, await f.agentInput({ ownerRecipient: substituted }, 1)),
    ).rejects.toMatchObject({
      code: 'owner_identity_mismatch',
    })
    expect((await f.service.agent(f.ownerId, f.agentId)).version).toBe(1)
  })

  it('deduplicates the plaintext command while rejecting changed payloads or conversations', async () => {
    const f = await createServiceFixture()
    const first = await f.submission()
    const run = await f.service.submit(f.ownerId, f.conversation.id, first)
    const reencrypted = await f.submission('Private prompt', first.commandId)
    expect(reencrypted.content).not.toEqual(first.content)
    expect((await f.service.submit(f.ownerId, f.conversation.id, reencrypted)).id).toBe(run.id)
    await expect(
      f.service.submit(f.ownerId, f.conversation.id, await f.submission('Changed', first.commandId)),
    ).rejects.toMatchObject({ code: 'command_payload_conflict' })
    const another = await f.service.createConversation(f.ownerId, f.agentId)
    await expect(f.service.submit(f.ownerId, another.id, first)).rejects.toMatchObject({
      code: 'command_payload_conflict',
    })
    expect((await f.service.state(f.ownerId, f.conversation.id)).runs).toHaveLength(1)
  })

  it('publishes the encrypted user prompt with the queued run and deduplicates later Pi input projection', async () => {
    const f = await createServiceFixture()
    const input = await f.submission('Visible while queued')
    const run = await f.service.submit(f.ownerId, f.conversation.id, input)
    const initial = await f.service.state(f.ownerId, f.conversation.id)
    expect(initial.runs[0]!.status).toBe('queued')
    expect(initial.messages).toHaveLength(1)
    const message = initial.messages[0]!
    expect(message).toMatchObject({ id: `${run.id}:input`, runId: run.id, sequence: 1 })
    expect(JSON.stringify(initial)).not.toContain('Visible while queued')
    expect(
      await decryptScopedJson(message.content, f.key, {
        ownerId: f.ownerId,
        scopeId: cloudAgentScope(f.agentId),
        keyEpoch: 1,
        recordId: message.id,
        purpose: 'message',
      }),
    ).toEqual({ role: 'user', text: 'Visible while queued' })
    await f.service.submit(f.ownerId, f.conversation.id, input)
    await f.service.appendMessage(run.id, 'pi:10:0', { role: 'user', text: 'Visible while queued' })
    expect((await f.service.state(f.ownerId, f.conversation.id)).messages).toHaveLength(1)
  })

  it('pins configuration per run and preserves encrypted history across normal updates', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    await f.service.saveAgent(f.ownerId, await f.agentInput({ instructions: 'New instructions' }, 1))
    expect((await f.service.loadRun(run.id)).config.instructions).toBe(f.config.instructions)
    expect((await f.service.openAgent(await f.service.getAgent(f.ownerId, f.agentId))).config.instructions).toBe(
      'New instructions',
    )
    await expect(f.service.saveAgent(f.ownerId, await f.agentInput({}, 1))).rejects.toMatchObject({
      code: 'agent_version_conflict',
    })
    await expect(
      f.service.saveAgent(f.ownerId, await f.agentInput({}, 2, await generateResourceKey())),
    ).rejects.toMatchObject({ code: 'rotation_required' })
    await expect(f.service.saveAgent(f.ownerId, await f.agentInput({}, 2, f.key, 2))).rejects.toMatchObject({
      code: 'rotation_required',
    })
    expect((await f.service.loadRun(run.id)).text).toBe('Private prompt')
  })

  it('replays agent and schedule saves without resetting versions or schedule progress', async () => {
    const f = await createServiceFixture()
    expect((await f.service.saveAgent(f.ownerId, f.input)).version).toBe(1)
    const update = await f.agentInput({ name: 'Renamed agent' }, 1)
    expect((await f.service.saveAgent(f.ownerId, update)).version).toBe(2)
    expect((await f.service.saveAgent(f.ownerId, update)).version).toBe(2)
    const id = crypto.randomUUID()
    const scope = {
      ownerId: f.ownerId,
      scopeId: cloudAgentScope(f.agentId),
      keyEpoch: 1,
      recordId: id,
      purpose: 'schedule',
    }
    const config = {
      name: 'Daily',
      prompt: 'Private scheduled prompt',
      timezone: 'UTC',
      cadence: { type: 'daily', hour: 12, minute: 0 },
    }
    const input = {
      id,
      agentId: f.agentId,
      expectedVersion: 0,
      keyEpoch: 1,
      enabled: true,
      config: await encryptScopedJson(config, f.key, scope),
    }
    const saved = await f.service.saveSchedule(f.ownerId, input)
    expect(await f.service.saveSchedule(f.ownerId, input)).toEqual(saved)
    const disabled = { ...input, expectedVersion: 1, enabled: false }
    expect((await f.service.saveSchedule(f.ownerId, disabled)).nextRunAt).toBeNull()
    expect((await f.service.saveSchedule(f.ownerId, disabled)).version).toBe(2)
    await expect(f.service.saveSchedule(f.ownerId, { ...disabled, enabled: true })).rejects.toMatchObject({
      code: 'schedule_version_conflict',
    })
    expect(JSON.stringify(await f.service.schedules(f.ownerId, f.agentId))).not.toContain('Private scheduled prompt')
    expect(JSON.stringify(await f.service.schedules(f.ownerId, f.agentId))).not.toContain('saveDigest')
  })

  it('projects each logical message once with strictly increasing conversation sequence', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    await f.service.appendMessage(run.id, 'entry:1', { role: 'assistant', text: 'Private answer' })
    await f.service.appendMessage(run.id, 'entry:1', { role: 'assistant', text: 'Private answer' })
    await f.service.appendMessage(run.id, 'entry:2', { role: 'tool', text: 'Private result', toolName: 'read' })
    const state = await f.service.state(f.ownerId, f.conversation.id)
    expect(state.messages.map((message) => message.sequence)).toEqual([1, 2, 3])
    expect(state.cursor).toBe(3)
    expect(JSON.stringify(state)).not.toContain('Private answer')
    const message = state.messages[1]!
    expect(
      await decryptScopedJson(message.content, f.key, {
        ownerId: f.ownerId,
        scopeId: cloudAgentScope(f.agentId),
        keyEpoch: 1,
        recordId: message.id,
        purpose: 'message',
      }),
    ).toEqual({ role: 'assistant', text: 'Private answer' })
  })

  it('binds approvals to owner, call arguments, and live revocation', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    await f.service.setStatus(run.id, 'running')
    const waiting = f.service.beforeTool(run.id, 'call-1', 'send', { text: 'Authorized payload' })
    const outcome = waiting.then(
      () => 'approved',
      (error: unknown) => error,
    )
    await waitForApproval(f, `${run.id}:call-1`)
    await expect(f.service.decide(crypto.randomUUID(), `${run.id}:call-1`, 'approved')).rejects.toMatchObject({
      code: 'approval_not_found',
    })
    await f.service.decide(f.ownerId, `${run.id}:call-1`, 'approved')
    expect(await outcome).toBe('approved')
    await expect(f.service.beforeTool(run.id, 'call-1', 'send', { text: 'Changed payload' })).rejects.toMatchObject({
      code: 'approval_mismatch',
    })
    await f.service.stop(f.ownerId, f.conversation.id)
    await expect(f.service.beforeTool(run.id, 'call-1', 'send', { text: 'Authorized payload' })).rejects.toMatchObject({
      code: 'run_stopped',
    })
    await expect(f.service.decide(f.ownerId, `${run.id}:call-1`, 'approved')).rejects.toMatchObject({
      code: 'run_stopped',
    })
    await f.service.setStatus(run.id, 'completed')
    expect((await f.service.loadRun(run.id)).run.status).toBe('stop-requested')
    await f.service.setStatus(run.id, 'uncertain', 'tool_outcome_uncertain')
    expect((await f.service.loadRun(run.id)).run.status).toBe('uncertain')
  })

  it('applies tightened approval policy to an already submitted full-access run', async () => {
    const f = await createServiceFixture({ approvalMode: 'full-access' })
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    await f.service.beforeTool(run.id, 'initial', 'read', {})
    await f.service.saveAgent(f.ownerId, await f.agentInput({ approvalMode: 'ask' }, 1))
    const abort = new AbortController()
    const pending = f.service.beforeTool(run.id, 'tightened', 'read', {}, abort.signal)
    const outcome = pending.then(
      () => false,
      () => true,
    )
    await waitForApproval(f, `${run.id}:tightened`)
    abort.abort()
    expect(await outcome).toBe(true)
    expect((await f.service.loadRun(run.id)).run.status).toBe('awaiting-approval')
  })

  it('disabling an agent stops existing work and rejects new submissions', async () => {
    const f = await createServiceFixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    await f.service.saveAgent(f.ownerId, { ...(await f.agentInput({}, 1)), enabled: false })
    expect((await f.service.loadRun(run.id)).run.status).toBe('stop-requested')
    await expect(f.service.checkExecution(run.id)).rejects.toMatchObject({ code: 'grant_revoked' })
    await expect(f.service.submit(f.ownerId, f.conversation.id, await f.submission())).rejects.toMatchObject({
      code: 'agent_disabled_or_revoked',
    })
  })
})

const postgresSuite = process.env.CLOUD_AGENT_TEST_DATABASE_URL ? describe : describe.skip
postgresSuite('cloud admission concurrency on real Postgres', () => {
  const client = postgres(process.env.CLOUD_AGENT_TEST_DATABASE_URL!, { max: 5 })
  const database = drizzle({ client, schema })
  const owners = new Set<string>()
  afterAll(async () => {
    for (const id of owners) {
      await database.delete(user).where(eq(user.id, id))
    }
    await client.end()
  })
  it('serializes concurrent daily reservations and makes duplicate commands consume one reservation', async () => {
    const f = await createServiceFixture({ database, dailyBudget: 1 })
    owners.add(f.ownerId)
    const second = await f.service.createConversation(f.ownerId, f.agentId)
    const inputs = [await f.submission('First'), await f.submission('Second')]
    const results = await Promise.allSettled([
      f.service.submit(f.ownerId, f.conversation.id, inputs[0]!),
      f.service.submit(f.ownerId, second.id, inputs[1]!),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const [row] = await database.select().from(cloudRuns).where(eq(cloudRuns.userId, f.ownerId))
    const input = inputs.find((value) => value.commandId === row!.commandId)!
    const duplicates = await Promise.all([
      f.service.submit(f.ownerId, row!.conversationId, input),
      f.service.submit(
        f.ownerId,
        row!.conversationId,
        await f.submission(row!.commandId === inputs[0]!.commandId ? 'First' : 'Second', row!.commandId),
      ),
    ])
    expect(duplicates[0]!.id).toBe(duplicates[1]!.id)
    expect(await database.select().from(cloudRuns).where(eq(cloudRuns.userId, f.ownerId))).toHaveLength(1)
  })
  it('gives conflicting approval decisions a single successful winner', async () => {
    const f = await createServiceFixture({ database })
    owners.add(f.ownerId)
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    const abort = new AbortController()
    const pending = f.service.beforeTool(run.id, 'decision-race', 'send', {}, abort.signal)
    const outcome = pending.then(
      () => undefined,
      () => undefined,
    )
    const id = `${run.id}:decision-race`
    await waitForApproval(f, id)
    const results = await Promise.allSettled([
      f.service.decide(f.ownerId, id, 'approved'),
      f.service.decide(f.ownerId, id, 'denied'),
    ])
    abort.abort()
    await outcome
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
})
