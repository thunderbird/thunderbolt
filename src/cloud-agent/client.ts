/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { agentModelPatch } from '@shared/cloud-agent/agent-models'
import { msg } from '@lingui/core/macro'
import { HttpError, type HttpClient } from '@/lib/http'
import { isSafeUrl } from '@/lib/url-utils'
import { type CloudOfflineStore, type CloudOutboxEntry } from './offline'
import {
  cloudAgentScope,
  cloudConnectionScope,
  cloudArtifactScope,
  type CloudAgentConfig,
  type CloudAgentRecord,
  type CloudCapabilities,
  type CloudConversation,
  type CloudConversationState,
  type CloudRun,
  type SubmitCloudMessage,
  type SaveCloudAgent,
  type CloudConnection,
  type CloudConnectionConfig,
  type SaveCloudConnection,
  type CloudSchedule,
  type CloudScheduleConfig,
  type SaveCloudSchedule,
  type CloudArtifact,
  type CloudArtifactState,
  type CloudArtifactGrant,
  type CloudArtifactRevision,
} from '@shared/cloud-agent/contracts'
import {
  generateResourceKey,
  sealResourceKey,
  openResourceKey,
  encryptScopedJson,
  decryptScopedJson,
  type ResourceKeyEnvelope,
  type ScopedCiphertext,
} from '@shared/cloud-agent/crypto'
import { createOwnerResourceIdentity, openOwnerResourceIdentity } from './keys'
import {
  cloudAgentConfigSchema,
  cloudConnectionConfigSchema,
  cloudMessageContentSchema,
  cloudApprovalPayloadSchema,
  cloudScheduleConfigSchema,
  artifactManifestSchema,
  artifactSnapshotSchema,
} from './validation'

export type CloudAgentDraft = Omit<CloudAgentConfig, 'ownerRecipient'>
export type CloudAgentView = { record: CloudAgentRecord; config: CloudAgentConfig }
export type CloudConnectionView = { record: CloudConnection; config: CloudConnectionConfig }
export type CloudScheduleView = { record: CloudSchedule; config: CloudScheduleConfig }
type IdentityRecord = Awaited<ReturnType<typeof createOwnerResourceIdentity>>
type KeyRecord = { id: string; keyEpoch: number; ownerKeyEnvelope: ResourceKeyEnvelope }

/** Bind every cloud request and resource key to the currently authenticated owner. */
export const createCloudAgentClient = (http: HttpClient, ownerId: string, offline: CloudOfflineStore) => {
  const disconnected = () => typeof navigator !== 'undefined' && !navigator.onLine
  const transient = (error: unknown) =>
    !(error instanceof HttpError) || error.response.status >= 500 || error.response.status === 429
  const read = async <T>(resource: string, signal?: AbortSignal): Promise<T> => {
    if (disconnected()) {
      const stored = await offline.read<T>(resource)
      if (stored !== undefined) {
        return stored
      }
      throw new Error(i18n._(msg`This item is not available offline yet.`))
    }
    try {
      const value = await http.get(`cloud-agents/${resource}`, { signal, timeout: 5000 }).json<T>()
      await offline.cache(resource, value)
      return value
    } catch (error) {
      if (signal?.aborted || !transient(error)) {
        throw error
      }
      const stored = await offline.read<T>(resource)
      if (stored !== undefined) {
        return stored
      }
      throw error
    }
  }
  const deliver = async (command: CloudOutboxEntry, signal?: AbortSignal): Promise<unknown> => {
    if (command.status === 'needs-review') {
      throw new Error(i18n._(msg`This queued change needs review before it can be sent.`))
    }
    if (disconnected()) {
      throw new Error(i18n._(msg`Saved on this device. It will be sent when you reconnect.`))
    }
    try {
      const result = await http
        .post(`cloud-agents/${command.endpoint}`, {
          json: JSON.parse(command.payload) as unknown,
          timeout: 15000,
          signal,
        })
        .json<unknown>()
      await offline.settle(command.id)
      return result
    } catch (error) {
      // A save may have committed before the response was lost. Recognize that exact
      // encrypted version; a different latest version remains a visible conflict.
      if (command.kind === 'agent-save' && error instanceof HttpError && error.response.status === 409) {
        const current = await http.get(`cloud-agents/agents/${command.resourceId}`, { signal }).json<CloudAgentRecord>()
        const submitted = JSON.parse(command.payload) as SaveCloudAgent
        if (
          current.version === submitted.expectedVersion + 1 &&
          current.keyEpoch === submitted.keyEpoch &&
          current.config.version === submitted.config.version &&
          current.config.kind === submitted.config.kind &&
          current.config.iv === submitted.config.iv &&
          current.config.ciphertext === submitted.config.ciphertext &&
          current.enabled === submitted.enabled
        ) {
          await offline.settle(command.id)
          return current
        }
      }
      if (!transient(error)) {
        await offline.fail(command.id, error instanceof HttpError ? String(error.response.status) : 'failed')
      }
      throw error
    }
  }
  const flushOutbox = async (signal?: AbortSignal) => {
    if (disconnected()) {
      return
    }
    for (const command of await offline.entries()) {
      if (signal?.aborted) {
        return
      }
      if (command.status !== 'pending') {
        continue
      }
      // Another tab or a user action can settle/discard a later entry while an
      // earlier request is in flight. Recheck before dispatching that command.
      const current = (await offline.entries()).find((entry) => entry.id === command.id)
      if (!current || current.status !== 'pending' || signal?.aborted) {
        continue
      }
      try {
        await deliver(current, signal)
      } catch (error) {
        if (transient(error)) {
          break
        }
      }
    }
  }
  const path = (suffix: string) => `cloud-agents/${suffix}`
  const keys = new Map<string, Promise<CryptoKey>>()
  const identityState: { pending?: Promise<Awaited<ReturnType<typeof openOwnerResourceIdentity>>> } = {}

  const loadIdentity = async () => {
    const existing = await read<{ identity: IdentityRecord | null }>('identity')
    if (existing.identity) {
      return openOwnerResourceIdentity(existing.identity, ownerId)
    }
    const candidate = await createOwnerResourceIdentity(ownerId)
    const stored = await http
      .post(path('identity'), { json: { identity: candidate } })
      .json<{ identity: IdentityRecord }>()
    await offline.cache('identity', stored)
    return openOwnerResourceIdentity(stored.identity, ownerId)
  }
  const identity = () => {
    identityState.pending ??= loadIdentity().catch((error: unknown) => {
      identityState.pending = undefined
      throw error
    })
    return identityState.pending
  }
  const context = (scopeId: string, keyEpoch: number) => ({ ownerId, scopeId, keyEpoch })
  const resourceKey = (record: KeyRecord, scopeId: string) => {
    const cacheId = `${scopeId}:${record.keyEpoch}`
    const cached = keys.get(cacheId)
    if (cached) {
      return cached
    }
    const pending = (async () =>
      openResourceKey(
        record.ownerKeyEnvelope,
        await identity(),
        {
          ...context(scopeId, record.keyEpoch),
          recipientId: ownerId,
        },
        true,
      ))().catch((error: unknown) => {
      keys.delete(cacheId)
      throw error
    })
    keys.set(cacheId, pending)
    return pending
  }
  const open = async <T>(
    record: KeyRecord,
    scopeId: string,
    content: ScopedCiphertext,
    recordId: string,
    purpose: string,
    schema: { parse: (value: unknown) => T },
  ): Promise<T> =>
    schema.parse(
      await decryptScopedJson(content, await resourceKey(record, scopeId), {
        ...context(scopeId, record.keyEpoch),
        recordId,
        purpose,
      }),
    )
  const seal = async (record: KeyRecord, scopeId: string, value: unknown, recordId: string, purpose: string) =>
    encryptScopedJson(value, await resourceKey(record, scopeId), {
      ...context(scopeId, record.keyEpoch),
      recordId,
      purpose,
    })
  const capabilities = () => read<CloudCapabilities>('capabilities')
  const prepareResource = async (id: string, scopeId: string, previous?: KeyRecord) => {
    const [ownerIdentity, available] = await Promise.all([identity(), capabilities()])
    if (!available.enabled || !available.runtimeRecipient) {
      throw new Error(i18n._(msg`Cloud agents are not available on this server.`))
    }
    const keyEpoch = previous?.keyEpoch ?? 1
    const key = previous ? await resourceKey(previous, scopeId) : await generateResourceKey()
    const keyContext = context(scopeId, keyEpoch)
    const [ownerKeyEnvelope, runtimeKeyEnvelope] = await Promise.all([
      sealResourceKey(key, ownerIdentity.publicKey, { ...keyContext, recipientId: ownerId }),
      sealResourceKey(key, available.runtimeRecipient, {
        ...keyContext,
        recipientId: available.runtimeRecipient.keyId,
      }),
    ])
    keys.set(`${scopeId}:${keyEpoch}`, Promise.resolve(key))
    return { id, keyEpoch, key, ownerKeyEnvelope, runtimeKeyEnvelope }
  }
  const agentView = async (record: CloudAgentRecord): Promise<CloudAgentView> => ({
    record,
    config: await open(
      record,
      cloudAgentScope(record.id),
      record.config,
      'config',
      'agent-config',
      cloudAgentConfigSchema,
    ),
  })
  const connectionView = async (record: CloudConnection): Promise<CloudConnectionView> => ({
    record,
    config: await open(
      record,
      cloudConnectionScope(record.id),
      record.config,
      'config',
      'connection-config',
      cloudConnectionConfigSchema,
    ),
  })
  const prepareAgent = async (
    config: CloudAgentDraft,
    previous?: CloudAgentRecord,
    enabled = previous?.enabled ?? true,
  ) => {
    const id = previous?.id ?? crypto.randomUUID()
    const resource = await prepareResource(id, cloudAgentScope(id), previous)
    const input: SaveCloudAgent = {
      id,
      expectedVersion: previous?.version ?? 0,
      keyEpoch: resource.keyEpoch,
      enabled,
      ownerKeyEnvelope: resource.ownerKeyEnvelope,
      runtimeKeyEnvelope: resource.runtimeKeyEnvelope,
      config: await encryptScopedJson(
        cloudAgentConfigSchema.parse({
          ...config,
          ...(config.models ? agentModelPatch(config.models) : {}),
          ownerRecipient: (await identity()).publicKey,
        }),
        resource.key,
        {
          ...context(cloudAgentScope(id), resource.keyEpoch),
          recordId: 'config',
          purpose: 'agent-config',
        },
      ),
    }
    return input
  }
  const submitAgent = async (input: SaveCloudAgent) => {
    const payload = JSON.stringify(input)
    const outstanding = (await offline.entries()).find(
      (entry) => entry.kind === 'agent-save' && entry.resourceId === input.id,
    )
    if (outstanding && outstanding.payload !== payload) {
      throw new Error(i18n._(msg`This agent already has a queued save. Review or discard it before saving again.`))
    }
    const command =
      outstanding ??
      (await offline.enqueue({
        id: crypto.randomUUID(),
        kind: 'agent-save',
        resourceId: input.id,
        endpoint: input.expectedVersion === 0 ? 'agents' : `agents/${input.id}`,
        payload,
      }))
    return agentView((await deliver(command)) as CloudAgentRecord)
  }
  const saveAgent = async (...args: Parameters<typeof prepareAgent>) => submitAgent(await prepareAgent(...args))
  const prepareConnection = async (
    config: CloudConnectionConfig,
    previous?: CloudConnection,
    enabled = previous?.enabled ?? true,
  ) => {
    const id = previous?.id ?? crypto.randomUUID()
    const resource = await prepareResource(id, cloudConnectionScope(id), previous)
    const input: SaveCloudConnection = {
      id,
      keyEpoch: resource.keyEpoch,
      expectedVersion: previous?.version ?? 0,
      enabled,
      ownerKeyEnvelope: resource.ownerKeyEnvelope,
      runtimeKeyEnvelope: resource.runtimeKeyEnvelope,
      config: await encryptScopedJson(cloudConnectionConfigSchema.parse(config), resource.key, {
        ...context(cloudConnectionScope(id), resource.keyEpoch),
        recordId: 'config',
        purpose: 'connection-config',
      }),
    }
    return input
  }
  const submitConnection = (input: SaveCloudConnection) =>
    http
      .post(path(input.expectedVersion === 0 ? 'connections' : `connections/${input.id}`), { json: input })
      .json<CloudConnection>()
  const saveConnection = async (...args: Parameters<typeof prepareConnection>) =>
    submitConnection(await prepareConnection(...args))
  const getConversation = async (agent: CloudAgentRecord, id: string, signal?: AbortSignal) => {
    const state = await read<CloudConversationState>(`conversations/${id}`, signal)
    const scope = cloudAgentScope(agent.id)
    const [messages, approvals] = await Promise.all([
      Promise.all(
        state.messages.map(async (record) => ({
          record,
          content: await open(agent, scope, record.content, record.id, 'message', cloudMessageContentSchema),
        })),
      ),
      Promise.all(
        state.approvals.map(async (record) => ({
          record,
          payload: await open(agent, scope, record.payload, record.id, 'approval', cloudApprovalPayloadSchema),
        })),
      ),
    ])
    return { ...state, decryptedMessages: messages, decryptedApprovals: approvals }
  }
  const getSchedules = async (agent: CloudAgentRecord): Promise<CloudScheduleView[]> => {
    const { schedules } = await read<{ schedules: CloudSchedule[] }>(`agents/${agent.id}/schedules`)
    return Promise.all(
      schedules.map(async (record) => ({
        record,
        config: await open(
          agent,
          cloudAgentScope(agent.id),
          record.config,
          record.id,
          'schedule',
          cloudScheduleConfigSchema,
        ),
      })),
    )
  }
  const prepareSchedule = async (
    agent: CloudAgentRecord,
    config: CloudScheduleConfig,
    previous?: CloudSchedule,
    enabled = previous?.enabled ?? true,
  ) => {
    const id = previous?.id ?? crypto.randomUUID()
    const input: SaveCloudSchedule = {
      id,
      agentId: agent.id,
      keyEpoch: agent.keyEpoch,
      enabled,
      expectedVersion: previous?.version ?? 0,
      config: await seal(agent, cloudAgentScope(agent.id), cloudScheduleConfigSchema.parse(config), id, 'schedule'),
    }
    return input
  }
  const submitSchedule = (input: SaveCloudSchedule) =>
    http.post(path(`agents/${input.agentId}/schedules/${input.id}`), { json: input }).json<CloudSchedule>()
  const saveSchedule = async (...args: Parameters<typeof prepareSchedule>) =>
    submitSchedule(await prepareSchedule(...args))
  const getArtifact = async (id: string) => {
    const state = await read<CloudArtifactState>(`artifacts/${id}`)
    const revisions = await Promise.all(
      state.revisions.map(async (record) => ({
        record,
        manifest: await open(
          state.artifact,
          cloudArtifactScope(id),
          record.manifest,
          record.id,
          'artifact-manifest',
          artifactManifestSchema,
        ),
      })),
    )
    return { artifact: state.artifact, revisions }
  }
  return {
    capabilities,
    saveAgent,
    prepareAgent,
    submitAgent,
    saveConnection,
    prepareConnection,
    submitConnection,
    getConversation,
    getSchedules,
    saveSchedule,
    prepareSchedule,
    submitSchedule,
    getArtifact,
    outbox: offline.entries,
    discardQueued: offline.discard,
    flushOutbox,
    queuedAgentConfig: async (entry: CloudOutboxEntry) => {
      const input = JSON.parse(entry.payload) as SaveCloudAgent
      return open(input, cloudAgentScope(input.id), input.config, 'config', 'agent-config', cloudAgentConfigSchema)
    },
    queuedMessage: async (agent: CloudAgentRecord, conversationId: string) => {
      const entry = (await offline.entries()).find(
        (item) => item.kind === 'message' && item.resourceId === conversationId,
      )
      if (!entry) {
        return null
      }
      const submission = JSON.parse(entry.payload) as SubmitCloudMessage
      const content = await open(
        agent,
        cloudAgentScope(agent.id),
        submission.content,
        submission.commandId,
        'submission',
        {
          parse: (value: unknown) => {
            if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') {
              throw new Error('Invalid submission')
            }
            return value as { text: string }
          },
        },
      )
      return { text: content.text, submission }
    },
    artifactContent: async (artifact: CloudArtifact, revisionId: string) => {
      const { content } = await read<{ content: ScopedCiphertext }>(
        `artifacts/${artifact.id}/revisions/${revisionId}/content`,
      )
      return open(
        artifact,
        cloudArtifactScope(artifact.id),
        content,
        revisionId,
        'artifact-content',
        artifactSnapshotSchema,
      )
    },
    artifactGrants: async (artifactId: string) =>
      (await read<{ grants: CloudArtifactGrant[] }>(`artifacts/${artifactId}/grants`)).grants,
    grantArtifact: async (artifact: CloudArtifact, agentId: string, canWrite: boolean) => {
      const available = await capabilities()
      if (!available.enabled || !available.runtimeRecipient) {
        throw new Error(i18n._(msg`Cloud agents are not available on this server.`))
      }
      const scopeId = cloudArtifactScope(artifact.id)
      const keyEnvelope = await sealResourceKey(await resourceKey(artifact, scopeId), available.runtimeRecipient, {
        ...context(scopeId, artifact.keyEpoch),
        recipientId: `agent:${agentId}`,
      })
      await http.post(path(`artifacts/${artifact.id}/grants`), {
        json: { agentId, keyEpoch: artifact.keyEpoch, keyEnvelope, canWrite },
      })
    },
    revokeArtifact: async (artifactId: string, agentId: string) => {
      await http.post(path(`artifacts/${artifactId}/grants/${agentId}/revoke`), { json: {} })
    },
    prepareArtifact: async (
      artifact: CloudArtifact,
      parentRevisionId: string,
      title: string,
      files: { path: string; mediaType: string; content: string }[],
    ) => {
      const id = crypto.randomUUID()
      const scope = cloudArtifactScope(artifact.id)
      const manifest = {
        title,
        mediaType: files.length === 1 ? files[0].mediaType : 'application/vnd.thunderbolt.bundle+json',
        files: files.map((file) => ({
          path: file.path,
          mediaType: file.mediaType,
          size: new TextEncoder().encode(file.content).length,
        })),
      }
      const [sealedManifest, content] = await Promise.all([
        seal(artifact, scope, manifest, id, 'artifact-manifest'),
        seal(artifact, scope, { files }, id, 'artifact-content'),
      ])
      return {
        artifactId: artifact.id,
        body: { id, parentRevisionId, keyEpoch: artifact.keyEpoch, manifest: sealedManifest, content },
      }
    },
    submitArtifact: async (input: {
      artifactId: string
      body: {
        id: string
        parentRevisionId: string
        keyEpoch: number
        manifest: ScopedCiphertext
        content: ScopedCiphertext
      }
    }) => {
      try {
        return await http
          .post(path(`artifacts/${input.artifactId}/revisions`), { json: input.body })
          .json<CloudArtifactRevision>()
      } catch (error) {
        if (error instanceof HttpError && error.response.status === 413) {
          const body: unknown = await error.response.json()
          if (body && typeof body === 'object' && 'error' in body && body.error === 'artifact_storage_quota_exceeded') {
            throw new Error(
              i18n._(
                msg`This revision exceeds your cloud artifact storage limit. Contact your administrator to increase it.`,
              ),
              { cause: error },
            )
          }
        }
        throw error
      }
    },
    agents: async () => Promise.all((await read<{ agents: CloudAgentRecord[] }>('agents')).agents.map(agentView)),
    connections: async () =>
      Promise.all((await read<{ connections: CloudConnection[] }>('connections')).connections.map(connectionView)),
    conversations: async (agentId: string, signal?: AbortSignal) =>
      (await read<{ conversations: CloudConversation[] }>(`agents/${agentId}/conversations`, signal)).conversations,
    createConversation: (agentId: string, id: string) =>
      http.post(path(`agents/${agentId}/conversations`), { json: { id } }).json<CloudConversation>(),
    prepareMessage: async (
      agent: CloudAgentRecord,
      text: string,
      commandId: string = crypto.randomUUID(),
      approvalMode: 'ask' | 'full-access' = 'ask',
    ): Promise<SubmitCloudMessage> => {
      return {
        commandId,
        keyEpoch: agent.keyEpoch,
        content: await seal(agent, cloudAgentScope(agent.id), { text, approvalMode }, commandId, 'submission'),
      }
    },
    submitMessage: async (id: string, submission: SubmitCloudMessage) => {
      const command = await offline.enqueue({
        id: submission.commandId,
        kind: 'message',
        resourceId: id,
        endpoint: `conversations/${id}/messages`,
        payload: JSON.stringify(submission),
      })
      return (await deliver(command)) as CloudRun
    },
    stop: (conversationId: string) =>
      http.post(path(`conversations/${conversationId}/stop`), { json: {} }).json<unknown>(),
    decide: (approvalId: string, decision: 'approved' | 'denied') =>
      http.post(path(`approvals/${approvalId}/decide`), { json: { decision } }).json<unknown>(),
    artifacts: async () => (await read<{ artifacts: CloudArtifact[] }>('artifacts')).artifacts,
    startConnectionOAuth: async (id: string) => {
      try {
        const result = await http
          .post(path(`connections/${id}/oauth/start`), { json: {} })
          .json<{ authorizationUrl: string; expiresAt: string }>()
        if (!isSafeUrl(result.authorizationUrl)) {
          throw new Error(i18n._(msg`The server returned an invalid authorization URL.`))
        }
        return result
      } catch (error) {
        if (error instanceof HttpError) {
          const body: unknown = await error.response.json()
          const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined
          if (code === 'cloud_oauth_unavailable') {
            throw new Error(i18n._(msg`Cloud OAuth is not configured on this server. Contact your administrator.`), {
              cause: error,
            })
          }
          if (code === 'oauth_registration_unavailable') {
            throw new Error(i18n._(msg`This MCP server does not support automatic OAuth registration.`), {
              cause: error,
            })
          }
        }
        throw error
      }
    },
    testConnection: (id: string) => http.post(path(`connections/${id}/test`), { json: {} }).json<unknown>(),
  }
}

export type CloudAgentClient = ReturnType<typeof createCloudAgentClient>
export type CloudConversationView = Awaited<ReturnType<CloudAgentClient['getConversation']>>
export type CloudArtifactView = Awaited<ReturnType<CloudAgentClient['getArtifact']>>
