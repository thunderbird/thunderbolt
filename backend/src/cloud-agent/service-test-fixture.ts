/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  cloudAgentScope,
  cloudConnectionScope,
  type CloudAgentConfig,
  type CloudConnectionConfig,
  type CloudModel,
  type SaveCloudAgent,
} from '@shared/cloud-agent/contracts'
import {
  encryptScopedJson,
  generateResourceIdentity,
  generateResourceKey,
  sealResourceKey,
} from '@shared/cloud-agent/crypto'
import { user } from '../db/auth-schema'
import { cloudIdentities } from '../db/cloud-agent-schema'
import { getSharedIsolatedTestDb } from '../test-utils/db'
import { readCloudSettings } from './config'
import { createCloudAgentService, type CloudDatabase } from './service'

const identities = Promise.all([generateResourceIdentity(), generateResourceIdentity()])
export const fixtureManagedModel: CloudModel = {
  provider: 'managed',
  modelId: 'fixture-managed',
  contextWindow: 32768,
  maxOutputTokens: 1024,
}

/** Save an actual encrypted, owner-scoped connection without contacting an external service. */
export const saveFixtureConnection = async (
  fixture: Awaited<ReturnType<typeof createServiceFixture>>,
  changes: Partial<CloudConnectionConfig> = {},
  enabled = true,
) => {
  const id = crypto.randomUUID()
  const key = await generateResourceKey()
  const scope = { ownerId: fixture.ownerId, scopeId: cloudConnectionScope(id), keyEpoch: 1 }
  const config: CloudConnectionConfig = {
    name: 'Test tools',
    kind: 'mcp',
    url: 'https://tools.example.test/mcp',
    authentication: { type: 'none' },
    ...changes,
  }
  await fixture.service.saveConnection(fixture.ownerId, {
    id,
    keyEpoch: 1,
    expectedVersion: 0,
    enabled,
    config: await encryptScopedJson(config, key, { ...scope, recordId: 'config', purpose: 'connection-config' }),
    ownerKeyEnvelope: await sealResourceKey(key, fixture.ownerIdentity.publicKey, {
      ...scope,
      recipientId: fixture.ownerId,
    }),
    runtimeKeyEnvelope: await sealResourceKey(key, fixture.runtimeIdentity.publicKey, {
      ...scope,
      recipientId: fixture.runtimeIdentity.publicKey.keyId,
    }),
  })
  return { id, key, config }
}

/** Real key envelopes and scoped ciphertext exercise service boundaries in an isolated database. */
export const createServiceFixture = async (
  options: {
    database?: CloudDatabase
    dailyBudget?: number
    maxAgents?: number
    approvalMode?: CloudAgentConfig['approvalMode']
  } = {},
) => {
  const database = options.database ?? (await getSharedIsolatedTestDb()).db
  const [runtimeIdentity, ownerIdentity] = await identities
  const ownerId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  await database.insert(user).values({ id: ownerId, email: `${ownerId}@cloud-runtime.test`, name: 'Cloud test owner' })
  await database
    .insert(cloudIdentities)
    .values({ userId: ownerId, publicKey: ownerIdentity.publicKey, privateRecord: {} })
  const settings = readCloudSettings({
    CLOUD_AGENTS_ENABLED: 'true',
    CLOUD_AGENT_RUNTIME_IDENTITY: JSON.stringify(runtimeIdentity),
    CLOUD_AGENT_OWNER_DAILY_BUDGET_USD: String(options.dailyBudget ?? 20),
    CLOUD_AGENT_MAX_PER_OWNER: String(options.maxAgents ?? 25),
  })
  const service = createCloudAgentService(database, settings, fixtureManagedModel)
  const key = await generateResourceKey()
  const config: CloudAgentConfig & { model: CloudModel } = {
    ownerRecipient: ownerIdentity.publicKey,
    name: 'Scoped agent',
    description: 'An encrypted test agent',
    instructions: 'These instructions are private.',
    model: fixtureManagedModel,
    skills: [],
    connectionIds: [],
    searchEnabled: false,
    approvalMode: options.approvalMode ?? 'ask',
    maxSteps: 10,
    maxRunCostUsd: 1,
  }
  const agentInput = async (
    changes: Partial<CloudAgentConfig> = {},
    expectedVersion = 0,
    resourceKey = key,
    keyEpoch = 1,
  ): Promise<SaveCloudAgent> => {
    const scope = { ownerId, scopeId: cloudAgentScope(agentId), keyEpoch }
    return {
      id: agentId,
      expectedVersion,
      keyEpoch,
      enabled: true,
      config: await encryptScopedJson({ ...config, ...changes }, resourceKey, {
        ...scope,
        recordId: 'config',
        purpose: 'agent-config',
      }),
      ownerKeyEnvelope: await sealResourceKey(resourceKey, ownerIdentity.publicKey, { ...scope, recipientId: ownerId }),
      runtimeKeyEnvelope: await sealResourceKey(resourceKey, runtimeIdentity.publicKey, {
        ...scope,
        recipientId: runtimeIdentity.publicKey.keyId,
      }),
    }
  }
  const input = await agentInput()
  const saved = await service.saveAgent(ownerId, input)
  const conversation = await service.createConversation(ownerId, agentId)
  const submission = async (
    text = 'Private prompt',
    commandId: string = crypto.randomUUID(),
    approvalMode?: CloudAgentConfig['approvalMode'],
  ) => ({
    commandId,
    keyEpoch: 1,
    content: await encryptScopedJson({ text, ...(approvalMode ? { approvalMode } : {}) }, key, {
      ownerId,
      scopeId: cloudAgentScope(agentId),
      keyEpoch: 1,
      recordId: commandId,
      purpose: 'submission',
    }),
  })
  return {
    database,
    service,
    settings,
    ownerId,
    ownerIdentity,
    runtimeIdentity,
    agentId,
    key,
    config,
    saved,
    input,
    agentInput,
    conversation,
    submission,
  }
}
