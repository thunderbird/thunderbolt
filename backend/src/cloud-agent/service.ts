/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { agentModelPatch } from '@shared/cloud-agent/agent-models'
import { cloudSubmissionSchema } from '@shared/cloud-agent/validation'

import { and, asc, count, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { user } from '@/db/auth-schema'
import { setTimeout as delay } from 'node:timers/promises'
import type { db, QueryableDatabase } from '@/db/client'
import {
  cloudAgents,
  cloudApprovals,
  cloudConnections,
  cloudConversations,
  cloudIdentities,
  cloudMessages,
  cloudRuns,
  cloudSchedules,
} from '@/db/cloud-agent-schema'
import {
  cloudAgentScope,
  cloudConnectionScope,
  type CloudAgentRecord,
  type CloudCapabilities,
  type CloudConnection,
  type CloudConversation,
  type CloudConversationState,
  type CloudMessageContent,
  type CloudModel,
  type CloudRun,
  type CloudRunStatus,
  type CloudSchedule,
  type SaveCloudAgent,
  type SaveCloudConnection,
  type SaveCloudSchedule,
  type SubmitCloudMessage,
} from '@shared/cloud-agent/contracts'
import {
  decryptScopedJson,
  encryptScopedJson,
  indexScopedValue,
  openResourceKey,
  resourceIdentityFingerprint,
  type ResourceKeyEnvelope,
} from '@shared/cloud-agent/crypto'
import {
  cloudAgentConfigSchema,
  cloudConnectionConfigSchema,
  cloudScheduleConfigSchema,
} from '@shared/cloud-agent/validation'
import type { CloudSettings } from './config'
import { CloudError } from './errors'
import type { identitySchema } from './input'
import { nextOccurrence } from './schedule'

export type CloudDatabase = typeof db
export type AgentRow = typeof cloudAgents.$inferSelect
export type RunRow = typeof cloudRuns.$inferSelect
export type ConnectionRow = typeof cloudConnections.$inferSelect
export const activeRunStatuses: CloudRunStatus[] = ['queued', 'running', 'awaiting-approval', 'stop-requested']
const now = () => new Date().toISOString()
const agentRecord = ({
  userId,
  saveDigest: _digest,
  runtimeKeyEnvelope: _runtime,
  ...record
}: AgentRow): CloudAgentRecord => ({ ...record, ownerId: userId })
const connectionRecord = ({
  userId,
  saveDigest: _digest,
  credentialVersion: _credentialVersion,
  runtimeKeyEnvelope: _runtime,
  createdAt: _created,
  status,
  ...record
}: ConnectionRow): CloudConnection => ({
  ...record,
  ownerId: userId,
  status: z.enum(['ready', 'unverified', 'needs-authorization', 'unreachable']).parse(status),
})
const conversationRecord = ({
  userId,
  piConversationId: _pi,
  ...record
}: typeof cloudConversations.$inferSelect): CloudConversation => ({ ...record, ownerId: userId })
const runRecord = ({
  id,
  conversationId,
  commandId,
  configVersion,
  status,
  errorCode,
  createdAt,
  updatedAt,
}: RunRow): CloudRun => ({ id, conversationId, commandId, configVersion, status, errorCode, createdAt, updatedAt })
const scheduleRecord = ({
  userId: _owner,
  saveDigest: _digest,
  activeRunId: _run,
  ...record
}: typeof cloudSchedules.$inferSelect): CloudSchedule => record
/** Ciphertext request identity makes a saved command replayable after its response was lost. */
const saveDigest = (input: SaveCloudAgent | SaveCloudConnection | SaveCloudSchedule) =>
  new Bun.CryptoHasher('sha256').update(JSON.stringify(input)).digest('hex')

/** Owner checks happen at the database boundary, including indirect conversation and approval access. */
export const createCloudAgentService = (
  database: CloudDatabase,
  settings: CloudSettings,
  managedModel: CloudModel | null = null,
) => {
  /** Scheduled and interactive execution require a registered owner, including during a transaction. */
  const requireCloudAccount = async (ownerId: string, source: QueryableDatabase = database) => {
    const [owner] = await source.select({ isAnonymous: user.isAnonymous }).from(user).where(eq(user.id, ownerId))
    if (!owner || owner.isAnonymous) {
      throw new CloudError(403, 'cloud_account_required')
    }
  }
  const available = () => {
    if (!settings.enabled || !settings.identity) {
      throw new CloudError(503, 'cloud_agents_unavailable')
    }
    return settings.identity
  }
  const getAgent = async (ownerId: string, id: string) => {
    const [row] = await database
      .select()
      .from(cloudAgents)
      .where(and(eq(cloudAgents.id, id), eq(cloudAgents.userId, ownerId), isNull(cloudAgents.deletedAt)))
    if (!row) {
      throw new CloudError(404, 'agent_not_found')
    }
    return row
  }
  const getConnection = async (ownerId: string, id: string) => {
    const [row] = await database
      .select()
      .from(cloudConnections)
      .where(and(eq(cloudConnections.id, id), eq(cloudConnections.userId, ownerId), isNull(cloudConnections.deletedAt)))
    if (!row) {
      throw new CloudError(404, 'connection_not_found')
    }
    return row
  }
  const getConversation = async (ownerId: string, id: string) => {
    const [row] = await database
      .select()
      .from(cloudConversations)
      .where(
        and(
          eq(cloudConversations.id, id),
          eq(cloudConversations.userId, ownerId),
          isNull(cloudConversations.deletedAt),
        ),
      )
    if (!row) {
      throw new CloudError(404, 'conversation_not_found')
    }
    return row
  }
  const keyFor = async (
    ownerId: string,
    scopeId: string,
    row: { keyEpoch: number; runtimeKeyEnvelope: ResourceKeyEnvelope },
  ) => {
    const identity = available()
    return openResourceKey(
      row.runtimeKeyEnvelope,
      identity,
      { ownerId, scopeId, keyEpoch: row.keyEpoch, recipientId: identity.publicKey.keyId },
      true,
    )
  }
  const openAgent = async (agent: AgentRow) => {
    const key = await keyFor(agent.userId, cloudAgentScope(agent.id), agent)
    const config = cloudAgentConfigSchema.parse(
      await decryptScopedJson(agent.config, key, {
        ownerId: agent.userId,
        scopeId: cloudAgentScope(agent.id),
        keyEpoch: agent.keyEpoch,
        recordId: 'config',
        purpose: 'agent-config',
      }),
    )
    return { key, config: config.models ? { ...config, ...agentModelPatch(config.models) } : config }
  }
  const openConnection = async (row: ConnectionRow) => {
    const key = await keyFor(row.userId, cloudConnectionScope(row.id), row)
    const config = cloudConnectionConfigSchema.parse(
      await decryptScopedJson(row.config, key, {
        ownerId: row.userId,
        scopeId: cloudConnectionScope(row.id),
        keyEpoch: row.keyEpoch,
        recordId: 'config',
        purpose: 'connection-config',
      }),
    )
    return { key, config }
  }
  const checkOwnerEnvelope = async (ownerId: string, envelope: ResourceKeyEnvelope) => {
    const [owner] = await database.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId))
    if (!owner || envelope.recipientKeyId !== owner.publicKey.keyId) {
      throw new CloudError(409, 'owner_identity_required')
    }
  }
  const checkSameKey = async (
    ownerId: string,
    scopeId: string,
    previous: { keyEpoch: number; runtimeKeyEnvelope: ResourceKeyEnvelope },
    key: CryptoKey,
  ) => {
    const oldKey = await keyFor(ownerId, scopeId, previous)
    const context = { ownerId, scopeId, keyEpoch: previous.keyEpoch, purpose: 'resource-key-continuity' }
    const [oldDigest, newDigest] = await Promise.all([
      indexScopedValue('same-key', oldKey, context),
      indexScopedValue('same-key', key, context),
    ])
    if (oldDigest !== newDigest) {
      throw new CloudError(409, 'rotation_required')
    }
  }
  const checkConfig = async (ownerId: string, config: z.infer<typeof cloudAgentConfigSchema>) => {
    const [owner] = await database.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId))
    if (
      !owner ||
      (await resourceIdentityFingerprint(owner.publicKey)) !==
        (await resourceIdentityFingerprint(config.ownerRecipient))
    ) {
      throw new CloudError(409, 'owner_identity_mismatch')
    }
    if (
      (config.maxSteps !== null && config.maxSteps > 100) ||
      (config.maxRunCostUsd !== null && config.maxRunCostUsd > 100) ||
      config.skills.length > 50 ||
      config.instructions.length > 100_000 ||
      config.skills.some((skill) => skill.instruction.length > 100_000)
    ) {
      throw new CloudError(422, 'agent_limits_exceeded')
    }
    const models = (config.models?.map((entry) => entry.model) ?? [config.model]).filter((model) => model !== null)
    if (
      models.some((model) => model.provider === 'managed' && (!managedModel || managedModel.modelId !== model.modelId))
    ) {
      throw new CloudError(422, 'managed_model_unavailable')
    }
    const modelConnectionIds = new Set(models.flatMap((model) => (model.connectionId ? [model.connectionId] : [])))
    const ids = new Set([...config.connectionIds, ...modelConnectionIds])
    for (const id of ids) {
      const connection = await getConnection(ownerId, id)
      if (!connection.enabled && modelConnectionIds.has(id)) {
        throw new CloudError(409, 'connection_disabled')
      }
      const { config: connectionConfig } = await openConnection(connection)
      const expectedKind = modelConnectionIds.has(id) ? 'model' : 'mcp'
      if (connectionConfig.kind !== expectedKind) {
        throw new CloudError(422, 'connection_kind_mismatch')
      }
    }
    if (models.some((model) => model.provider !== 'managed' && !model.connectionId)) {
      throw new CloudError(422, 'model_connection_required')
    }
  }
  const capabilities = async (ownerId: string): Promise<CloudCapabilities> => {
    const [identity] = await database.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId))
    return {
      enabled: settings.enabled,
      runtimeRecipient: settings.identity?.publicKey ?? null,
      ownerRecipient: identity?.publicKey ?? null,
      limits: {
        maxAgents: settings.maxAgents,
        maxArtifactBytes: settings.maxArtifactBytes,
        maxStorageBytes: settings.maxStorageBytes,
        maxConcurrentRuns: settings.maxConcurrentRuns,
      },
      managedModel,
    }
  }
  const identity = async (ownerId: string) => {
    const [record] = await database.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId))
    return { identity: record?.privateRecord ?? null }
  }
  const saveIdentity = async (ownerId: string, input: z.infer<typeof identitySchema>) => {
    available()
    await database
      .insert(cloudIdentities)
      .values({ userId: ownerId, publicKey: input.identity.publicKey, privateRecord: input.identity })
      .onConflictDoNothing()
    return identity(ownerId)
  }
  const saveAgent = async (ownerId: string, input: SaveCloudAgent) => {
    available()
    await checkOwnerEnvelope(ownerId, input.ownerKeyEnvelope)
    const { expectedVersion, ...values } = input
    const candidate = {
      ...values,
      saveDigest: saveDigest(input),
      userId: ownerId,
      version: expectedVersion + 1,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    }
    const { config, key } = await openAgent(candidate)
    await checkConfig(ownerId, config)
    return database.transaction(async (tx) => {
      // Serialize per-owner creation against the limit, without sharing other owners' state.
      await tx.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId)).for('update')
      const [previous] = await tx
        .select()
        .from(cloudAgents)
        .where(and(eq(cloudAgents.id, input.id), eq(cloudAgents.userId, ownerId), isNull(cloudAgents.deletedAt)))
        .for('update')
      if (previous?.version === expectedVersion + 1 && previous.saveDigest === candidate.saveDigest) {
        return agentRecord(previous)
      }
      if (expectedVersion === 0) {
        if (input.keyEpoch !== 1) {
          throw new CloudError(422, 'invalid_key_epoch')
        }
        const [total] = await tx
          .select({ value: count() })
          .from(cloudAgents)
          .where(and(eq(cloudAgents.userId, ownerId), isNull(cloudAgents.deletedAt)))
        if (total.value >= settings.maxAgents) {
          throw new CloudError(409, 'agent_limit_reached')
        }
        const [created] = await tx.insert(cloudAgents).values(candidate).onConflictDoNothing().returning()
        if (!created) {
          throw new CloudError(409, 'agent_version_conflict')
        }
        return agentRecord(created)
      }
      if (!previous || previous.version !== expectedVersion) {
        throw new CloudError(409, 'agent_version_conflict')
      }
      // Rotation is a separate operation: ordinary Save must not strand old history.
      if (previous.keyEpoch !== input.keyEpoch) {
        throw new CloudError(409, 'rotation_required')
      }
      await checkSameKey(ownerId, cloudAgentScope(input.id), previous, key)
      const [saved] = await tx
        .update(cloudAgents)
        .set({ ...values, saveDigest: candidate.saveDigest, version: expectedVersion + 1, updatedAt: now() })
        .where(eq(cloudAgents.id, input.id))
        .returning()
      if (!saved.enabled) {
        await tx
          .update(cloudRuns)
          .set({ status: 'stop-requested', updatedAt: now() })
          .where(and(eq(cloudRuns.agentId, saved.id), inArray(cloudRuns.status, activeRunStatuses)))
      }
      return agentRecord(saved)
    })
  }
  const saveConnection = async (ownerId: string, input: SaveCloudConnection) => {
    available()
    await checkOwnerEnvelope(ownerId, input.ownerKeyEnvelope)
    const { expectedVersion, ...values } = input
    const candidate = {
      ...values,
      saveDigest: saveDigest(input),
      userId: ownerId,
      version: expectedVersion + 1,
      credentialVersion: 1,
      status: 'unverified',
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    }
    const { config, key } = await openConnection(candidate)
    const endpoint = new URL(config.url)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      throw new CloudError(422, 'connection_requires_https')
    }
    return database.transaction(async (tx) => {
      await tx.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId)).for('update')
      const [previous] = await tx
        .select()
        .from(cloudConnections)
        .where(
          and(
            eq(cloudConnections.id, input.id),
            eq(cloudConnections.userId, ownerId),
            isNull(cloudConnections.deletedAt),
          ),
        )
        .for('update')
      if (previous?.version === expectedVersion + 1 && previous.saveDigest === candidate.saveDigest) {
        return connectionRecord(previous)
      }
      if (expectedVersion === 0) {
        if (input.keyEpoch !== 1) {
          throw new CloudError(422, 'invalid_key_epoch')
        }
        const [created] = await tx.insert(cloudConnections).values(candidate).onConflictDoNothing().returning()
        if (!created) {
          throw new CloudError(409, 'connection_version_conflict')
        }
        return connectionRecord(created)
      }
      if (!previous || previous.version !== expectedVersion) {
        throw new CloudError(409, 'connection_version_conflict')
      }
      if (previous.keyEpoch !== input.keyEpoch) {
        throw new CloudError(409, 'rotation_required')
      }
      await checkSameKey(ownerId, cloudConnectionScope(input.id), previous, key)
      const { config: current } = await openConnection(previous)
      // Refresh owns the live OAuth token. Ordinary metadata edits cannot restore a stale browser copy.
      const preserved =
        current.authentication.type === 'oauth' &&
        config.authentication.type === 'oauth' &&
        current.url === config.url &&
        current.kind === config.kind
      const content = preserved
        ? await encryptScopedJson({ ...config, authentication: current.authentication }, key, {
            ownerId,
            scopeId: cloudConnectionScope(input.id),
            keyEpoch: input.keyEpoch,
            recordId: 'config',
            purpose: 'connection-config',
          })
        : values.config
      const [saved] = await tx
        .update(cloudConnections)
        .set({
          ...values,
          config: content,
          saveDigest: candidate.saveDigest,
          version: expectedVersion + 1,
          credentialVersion: previous.credentialVersion + (preserved ? 0 : 1),
          updatedAt: now(),
          status: preserved ? previous.status : 'unverified',
        })
        .where(eq(cloudConnections.id, input.id))
        .returning()
      return connectionRecord(saved)
    })
  }
  const createConversation = async (ownerId: string, agentId: string, id: string = crypto.randomUUID()) => {
    await getAgent(ownerId, agentId)
    await requireCloudAccount(ownerId)
    const [row] = await database
      .insert(cloudConversations)
      .values({ id, userId: ownerId, agentId })
      .onConflictDoNothing()
      .returning()
    if (row) {
      return conversationRecord(row)
    }
    const [existing] = await database
      .select()
      .from(cloudConversations)
      .where(
        and(
          eq(cloudConversations.id, id),
          eq(cloudConversations.userId, ownerId),
          eq(cloudConversations.agentId, agentId),
          isNull(cloudConversations.deletedAt),
        ),
      )
    if (!existing) {
      throw new CloudError(409, 'conversation_id_conflict')
    }
    return conversationRecord(existing)
  }
  const loadRun = async (runId: string) => {
    const [run] = await database.select().from(cloudRuns).where(eq(cloudRuns.id, runId))
    if (!run) {
      throw new CloudError(404, 'run_not_found')
    }
    const agent = await getAgent(run.userId, run.agentId)
    if (run.keyEpoch !== agent.keyEpoch) {
      throw new CloudError(409, 'grant_revoked')
    }
    const { key, config } = await openAgent({ ...agent, config: run.config })
    if (!config.model) {
      throw new CloudError(422, 'cloud_model_unavailable')
    }
    const payload = cloudSubmissionSchema.parse(
      await decryptScopedJson(run.content, key, {
        ownerId: run.userId,
        scopeId: cloudAgentScope(agent.id),
        keyEpoch: run.keyEpoch,
        recordId: run.commandId,
        purpose: 'submission',
      }),
    )
    return {
      run,
      agent,
      key,
      config: { ...config, model: config.model, approvalMode: payload.approvalMode ?? config.approvalMode },
      text: payload.text,
      explicitApproval: payload.approvalMode !== undefined,
    }
  }
  const submit = async (ownerId: string, conversationId: string, input: SubmitCloudMessage) => {
    available()
    if (!settings.executionEnabled) {
      throw new CloudError(409, 'execution_paused')
    }
    const conversation = await getConversation(ownerId, conversationId)
    await requireCloudAccount(ownerId)
    const agent = await getAgent(ownerId, conversation.agentId)
    if (!agent.enabled || agent.keyEpoch !== input.keyEpoch) {
      throw new CloudError(409, 'agent_disabled_or_revoked')
    }
    const { key, config } = await openAgent(agent)
    const payload = cloudSubmissionSchema.parse(
      await decryptScopedJson(input.content, key, {
        ownerId,
        scopeId: cloudAgentScope(agent.id),
        keyEpoch: input.keyEpoch,
        recordId: input.commandId,
        purpose: 'submission',
      }),
    )
    const commandDigest = await indexScopedValue(JSON.stringify({ conversationId, ...payload }), key, {
      ownerId,
      scopeId: cloudAgentScope(agent.id),
      keyEpoch: agent.keyEpoch,
      purpose: 'command-digest',
    })
    return database.transaction(async (tx) => {
      await tx.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId)).for('update')
      await tx.select().from(cloudConversations).where(eq(cloudConversations.id, conversationId)).for('update')
      const [existing] = await tx
        .select()
        .from(cloudRuns)
        .where(and(eq(cloudRuns.userId, ownerId), eq(cloudRuns.commandId, input.commandId)))
      if (existing) {
        if (existing.commandDigest !== commandDigest) {
          throw new CloudError(409, 'command_payload_conflict')
        }
        return runRecord(existing)
      }
      if (!config.model) {
        throw new CloudError(422, 'cloud_model_unavailable')
      }
      const [pending] = await tx
        .select({ value: count() })
        .from(cloudRuns)
        .where(and(eq(cloudRuns.conversationId, conversationId), inArray(cloudRuns.status, activeRunStatuses)))
      if (pending.value >= 20) {
        throw new CloudError(429, 'conversation_queue_full')
      }
      const recent = await tx
        .select()
        .from(cloudRuns)
        .where(
          and(
            eq(cloudRuns.userId, ownerId),
            or(
              gte(cloudRuns.createdAt, new Date(Date.now() - 86_400_000).toISOString()),
              inArray(cloudRuns.status, activeRunStatuses),
            ),
          ),
        )
      const reserved = recent.reduce(
        (total, run) =>
          total +
          (activeRunStatuses.includes(run.status) || run.status === 'uncertain' ? run.reservedMicros : run.spentMicros),
        0,
      )
      if (reserved + Math.ceil((config.maxRunCostUsd ?? 0) * 1_000_000) > settings.ownerDailyBudgetUsd * 1_000_000) {
        throw new CloudError(429, 'cloud_daily_budget_exceeded')
      }
      const [run] = await tx
        .insert(cloudRuns)
        .values({
          id: crypto.randomUUID(),
          userId: ownerId,
          agentId: agent.id,
          conversationId,
          commandId: input.commandId,
          commandDigest,
          content: input.content,
          keyEpoch: agent.keyEpoch,
          configVersion: agent.version,
          config: agent.config,
          reservedMicros: Math.ceil((config.maxRunCostUsd ?? 0) * 1_000_000),
        })
        .returning()
      const messageId = `${run.id}:input`
      const [previous] = await tx
        .select({ value: sql<number>`coalesce(max(${cloudMessages.sequence}), 0)` })
        .from(cloudMessages)
        .where(eq(cloudMessages.conversationId, conversationId))
      await tx.insert(cloudMessages).values({
        id: messageId,
        userId: ownerId,
        conversationId,
        runId: run.id,
        sequence: Number(previous.value) + 1,
        keyEpoch: run.keyEpoch,
        content: await encryptScopedJson({ role: 'user', text: payload.text }, key, {
          ownerId,
          scopeId: cloudAgentScope(agent.id),
          keyEpoch: run.keyEpoch,
          recordId: messageId,
          purpose: 'message',
        }),
      })
      await tx.update(cloudConversations).set({ updatedAt: now() }).where(eq(cloudConversations.id, conversationId))
      return runRecord(run)
    })
  }
  const state = async (ownerId: string, conversationId: string): Promise<CloudConversationState> => {
    const conversation = await getConversation(ownerId, conversationId)
    const [runs, messages, approvals] = await Promise.all([
      database
        .select()
        .from(cloudRuns)
        .where(eq(cloudRuns.conversationId, conversationId))
        .orderBy(asc(cloudRuns.createdAt)),
      database
        .select()
        .from(cloudMessages)
        .where(eq(cloudMessages.conversationId, conversationId))
        .orderBy(asc(cloudMessages.sequence)),
      database
        .select({ approval: cloudApprovals })
        .from(cloudApprovals)
        .innerJoin(cloudRuns, eq(cloudApprovals.runId, cloudRuns.id))
        .where(eq(cloudRuns.conversationId, conversationId)),
    ])
    return {
      conversation: conversationRecord(conversation),
      runs: runs.map(runRecord),
      messages: messages.map(({ userId: _owner, ...record }) => record),
      approvals: approvals.map(
        ({
          approval: { userId: _owner, callId: _call, argumentDigest: _digest, updatedAt: _updated, status, ...record },
        }) => ({ ...record, status: z.enum(['pending', 'approved', 'denied', 'expired']).parse(status) }),
      ),
      cursor: messages.reduce((max, message) => Math.max(max, message.sequence), 0),
    }
  }
  const stop = async (ownerId: string, conversationId: string) => {
    await getConversation(ownerId, conversationId)
    await database
      .update(cloudRuns)
      .set({ status: 'stop-requested', updatedAt: now() })
      .where(and(eq(cloudRuns.conversationId, conversationId), inArray(cloudRuns.status, activeRunStatuses)))
    return { requested: true }
  }
  const checkExecution = async (runId: string) => {
    const [entry] = await database
      .select({ run: cloudRuns, agent: cloudAgents, isAnonymous: user.isAnonymous })
      .from(cloudRuns)
      .innerJoin(cloudAgents, eq(cloudRuns.agentId, cloudAgents.id))
      .innerJoin(user, eq(cloudRuns.userId, user.id))
      .where(eq(cloudRuns.id, runId))
    if (entry?.isAnonymous) {
      throw new CloudError(403, 'cloud_account_required')
    }
    if (
      !settings.executionEnabled ||
      !entry ||
      !entry.agent.enabled ||
      entry.agent.deletedAt ||
      entry.run.keyEpoch !== entry.agent.keyEpoch
    ) {
      throw new CloudError(409, 'grant_revoked')
    }
    if (!activeRunStatuses.includes(entry.run.status) || entry.run.status === 'stop-requested') {
      throw new CloudError(409, 'run_stopped')
    }
  }
  const setStatus = async (runId: string, status: CloudRunStatus, errorCode?: string) => {
    const allowed =
      status === 'stopped' || status === 'uncertain'
        ? activeRunStatuses
        : activeRunStatuses.filter((value) => value !== 'stop-requested')
    await database
      .update(cloudRuns)
      .set({ status, errorCode: errorCode ?? null, updatedAt: now() })
      .where(and(eq(cloudRuns.id, runId), inArray(cloudRuns.status, allowed)))
  }
  const appendMessage = async (runId: string, logicalId: string, content: CloudMessageContent) => {
    const { run, key } = await loadRun(runId)
    const id = `${runId}:${content.role === 'user' ? 'input' : logicalId}`
    const encrypted = await encryptScopedJson(content, key, {
      ownerId: run.userId,
      scopeId: cloudAgentScope(run.agentId),
      keyEpoch: run.keyEpoch,
      recordId: id,
      purpose: 'message',
    })
    await database.transaction(async (tx) => {
      await tx.select().from(cloudConversations).where(eq(cloudConversations.id, run.conversationId)).for('update')
      const [existing] = await tx.select().from(cloudMessages).where(eq(cloudMessages.id, id))
      if (existing) {
        return
      }
      const [previous] = await tx
        .select({ value: sql<number>`coalesce(max(${cloudMessages.sequence}), 0)` })
        .from(cloudMessages)
        .where(eq(cloudMessages.conversationId, run.conversationId))
      await tx.insert(cloudMessages).values({
        id,
        userId: run.userId,
        conversationId: run.conversationId,
        runId,
        sequence: Number(previous.value) + 1,
        keyEpoch: run.keyEpoch,
        content: encrypted,
      })
      await tx.update(cloudConversations).set({ updatedAt: now() }).where(eq(cloudConversations.id, run.conversationId))
    })
  }
  const decide = async (ownerId: string, id: string, decision: 'approved' | 'denied') => {
    const [approval] = await database
      .select()
      .from(cloudApprovals)
      .where(and(eq(cloudApprovals.id, id), eq(cloudApprovals.userId, ownerId)))
    if (!approval) {
      throw new CloudError(404, 'approval_not_found')
    }
    await checkExecution(approval.runId)
    if (approval.status !== 'pending' && approval.status !== decision) {
      throw new CloudError(409, 'approval_already_decided')
    }
    const [decided] = await database
      .update(cloudApprovals)
      .set({ status: decision, updatedAt: now() })
      .where(and(eq(cloudApprovals.id, id), eq(cloudApprovals.status, 'pending')))
      .returning()
    if (!decided) {
      const [current] = await database.select().from(cloudApprovals).where(eq(cloudApprovals.id, id))
      if (current?.status !== decision) {
        throw new CloudError(409, 'approval_already_decided')
      }
    }
    return { decision }
  }
  const beforeTool = async (
    runId: string,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    await checkExecution(runId)
    const { run, agent, config, key, explicitApproval } = await loadRun(runId)
    const { config: currentConfig } = await openAgent(agent)
    if (config.approvalMode === 'full-access' && (explicitApproval || currentConfig.approvalMode === 'full-access')) {
      return
    }
    const argumentDigest = await indexScopedValue(JSON.stringify({ toolName, arguments: args }), key, {
      ownerId: run.userId,
      scopeId: cloudAgentScope(run.agentId),
      keyEpoch: run.keyEpoch,
      purpose: 'tool-approval',
    })
    const id = `${runId}:${callId}`
    const payload = await encryptScopedJson({ toolName, arguments: args }, key, {
      ownerId: run.userId,
      scopeId: cloudAgentScope(run.agentId),
      keyEpoch: run.keyEpoch,
      recordId: id,
      purpose: 'approval',
    })
    await database
      .insert(cloudApprovals)
      .values({
        id,
        userId: run.userId,
        agentId: run.agentId,
        runId,
        callId,
        argumentDigest,
        keyEpoch: run.keyEpoch,
        payload,
      })
      .onConflictDoNothing()
    await setStatus(runId, 'awaiting-approval')
    for (;;) {
      signal?.throwIfAborted()
      await checkExecution(runId)
      const [approval] = await database.select().from(cloudApprovals).where(eq(cloudApprovals.id, id))
      if (!approval || approval.argumentDigest !== argumentDigest || approval.keyEpoch !== run.keyEpoch) {
        throw new CloudError(409, 'approval_mismatch')
      }
      if (approval.status === 'approved') {
        await setStatus(runId, 'running')
        return
      }
      if (approval.status !== 'pending') {
        throw new CloudError(403, 'tool_not_approved')
      }
      await delay(500, undefined, { signal })
    }
  }
  const saveSchedule = async (ownerId: string, input: SaveCloudSchedule) => {
    const agent = await getAgent(ownerId, input.agentId)
    if (agent.keyEpoch !== input.keyEpoch) {
      throw new CloudError(409, 'grant_revoked')
    }
    const { key } = await openAgent(agent)
    const config = cloudScheduleConfigSchema.parse(
      await decryptScopedJson(input.config, key, {
        ownerId,
        scopeId: cloudAgentScope(agent.id),
        keyEpoch: agent.keyEpoch,
        recordId: input.id,
        purpose: 'schedule',
      }),
    )
    if (config.conversationId) {
      const conversation = await getConversation(ownerId, config.conversationId)
      if (conversation.agentId !== agent.id) {
        throw new CloudError(422, 'schedule_agent_mismatch')
      }
    }
    const { expectedVersion, ...values } = input
    const data = {
      ...values,
      saveDigest: saveDigest(input),
      version: expectedVersion + 1,
      nextRunAt: input.enabled ? nextOccurrence(config, new Date()) : null,
      errorCode: null,
      retryAt: null,
      updatedAt: now(),
    }
    return database.transaction(async (tx) => {
      await tx.select().from(cloudIdentities).where(eq(cloudIdentities.userId, ownerId)).for('update')
      const [previous] = await tx
        .select()
        .from(cloudSchedules)
        .where(and(eq(cloudSchedules.id, input.id), eq(cloudSchedules.userId, ownerId)))
        .for('update')
      if (previous?.version === expectedVersion + 1 && previous.saveDigest === data.saveDigest) {
        return scheduleRecord(previous)
      }
      if (expectedVersion === 0) {
        const [saved] = await tx
          .insert(cloudSchedules)
          .values({ ...data, userId: ownerId })
          .onConflictDoNothing()
          .returning()
        if (!saved) {
          throw new CloudError(409, 'schedule_version_conflict')
        }
        return scheduleRecord(saved)
      }
      if (!previous || previous.version !== expectedVersion || previous.agentId !== agent.id) {
        throw new CloudError(409, 'schedule_version_conflict')
      }
      const [saved] = await tx.update(cloudSchedules).set(data).where(eq(cloudSchedules.id, input.id)).returning()
      return scheduleRecord(saved)
    })
  }
  return {
    database,
    settings,
    requireCloudAccount,
    capabilities,
    identity,
    saveIdentity,
    getAgent,
    openAgent,
    getConnection,
    openConnection,
    keyFor,
    saveAgent,
    saveConnection,
    createConversation,
    getConversation,
    submit,
    state,
    stop,
    decide,
    saveSchedule,
    loadRun,
    checkExecution,
    setStatus,
    appendMessage,
    beforeTool,
    agent: async (ownerId: string, id: string) => agentRecord(await getAgent(ownerId, id)),
    agents: async (ownerId: string) => ({
      agents: (
        await database
          .select()
          .from(cloudAgents)
          .where(and(eq(cloudAgents.userId, ownerId), isNull(cloudAgents.deletedAt)))
      ).map(agentRecord),
    }),
    connections: async (ownerId: string) => ({
      connections: (
        await database
          .select()
          .from(cloudConnections)
          .where(and(eq(cloudConnections.userId, ownerId), isNull(cloudConnections.deletedAt)))
      ).map(connectionRecord),
    }),
    conversations: async (ownerId: string, agentId: string) => {
      await getAgent(ownerId, agentId)
      return {
        conversations: (
          await database
            .select()
            .from(cloudConversations)
            .where(
              and(
                eq(cloudConversations.agentId, agentId),
                eq(cloudConversations.userId, ownerId),
                isNull(cloudConversations.deletedAt),
              ),
            )
            .orderBy(asc(cloudConversations.createdAt))
        ).map(conversationRecord),
      }
    },
    schedules: async (ownerId: string, agentId: string) => {
      await getAgent(ownerId, agentId)
      return {
        schedules: (
          await database
            .select()
            .from(cloudSchedules)
            .where(and(eq(cloudSchedules.agentId, agentId), eq(cloudSchedules.userId, ownerId)))
        ).map(scheduleRecord),
      }
    },
  }
}

export type CloudAgentService = ReturnType<typeof createCloudAgentService>
