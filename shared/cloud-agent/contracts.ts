/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ResourceKeyEnvelope, ResourcePublicKey, ScopedCiphertext } from './crypto'

export type CloudSkill = { sourceId?: string; name: string; description: string; instruction: string }
export type CloudModel = {
  sourceId?: string
  provider: 'managed' | 'openai-compatible' | 'anthropic'
  modelId: string
  baseUrl?: string
  connectionId?: string
  contextWindow: number
  maxOutputTokens: number
  inputCostPerMillion?: number
  outputCostPerMillion?: number
}
export type CloudAgentModel = { localModelId?: string; name: string; model: CloudModel | null }
export type CloudAgentConfig = {
  ownerRecipient: ResourcePublicKey
  name: string
  icon?: string | null
  description: string
  instructions: string
  model: CloudModel | null
  localModelId?: string
  models?: CloudAgentModel[]
  modelOrder?: string[]
  skills: CloudSkill[]
  mcpServers?: { sourceId: string; name: string }[]
  connectionIds: string[]
  searchEnabled: boolean
  approvalMode: 'ask' | 'full-access'
  maxSteps: number | null
  maxRunCostUsd: number | null
}

export type CloudAgentRecord = {
  id: string
  ownerId: string
  version: number
  keyEpoch: number
  enabled: boolean
  config: ScopedCiphertext
  ownerKeyEnvelope: ResourceKeyEnvelope
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}
export type SaveCloudAgent = {
  id: string
  expectedVersion: number
  keyEpoch: number
  enabled: boolean
  config: ScopedCiphertext
  ownerKeyEnvelope: ResourceKeyEnvelope
  runtimeKeyEnvelope: ResourceKeyEnvelope
}
export type CloudCapabilities = {
  enabled: boolean
  runtimeRecipient: ResourcePublicKey | null
  ownerRecipient: ResourcePublicKey | null
  limits: { maxAgents: number; maxArtifactBytes: number; maxStorageBytes?: number; maxConcurrentRuns: number }
  managedModel: CloudModel | null
}

export type CloudConversation = {
  id: string
  agentId: string
  ownerId: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}
export type CloudRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'stop-requested'
  | 'stopped'
  | 'failed'
  | 'blocked'
  | 'uncertain'
export type CloudRun = {
  id: string
  conversationId: string
  commandId: string
  configVersion: number
  status: CloudRunStatus
  errorCode: string | null
  createdAt: string
  updatedAt: string
}
export type CloudMessageContent = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  toolCallId?: string
  toolError?: boolean
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]
  artifactIds?: string[]
}
export type CloudMessage = {
  id: string
  conversationId: string
  runId: string
  sequence: number
  revision: number
  keyEpoch: number
  content: ScopedCiphertext
  createdAt: string
}
export type CloudApprovalPayload = { toolName: string; arguments: Record<string, unknown> }
export type CloudApproval = {
  id: string
  runId: string
  agentId: string
  keyEpoch: number
  status: 'pending' | 'approved' | 'denied' | 'expired'
  payload: ScopedCiphertext
  createdAt: string
}
export type CloudConversationState = {
  conversation: CloudConversation
  runs: CloudRun[]
  messages: CloudMessage[]
  approvals: CloudApproval[]
  cursor: number
}
export type SubmitCloudMessage = { commandId: string; content: ScopedCiphertext; keyEpoch: number }

export type CloudConnectionConfig = {
  libraryRef?: { kind: 'mcp' | 'model'; id: string }
  modelLimits?: {
    contextWindow: number
    maxOutputTokens: number
    inputCostPerMillion: number
    outputCostPerMillion: number
  }
  name: string
  kind: 'mcp' | 'model'
  url: string
  authentication:
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | {
        type: 'oauth'
        accessToken: string
        refreshToken?: string
        expiresAt?: string
        issuer: string
        tokenEndpoint: string
        clientId: string
        resource: string
      }
  allowedTools?: string[]
}
export type CloudConnection = {
  id: string
  ownerId: string
  version: number
  keyEpoch: number
  config: ScopedCiphertext
  ownerKeyEnvelope: ResourceKeyEnvelope
  enabled: boolean
  status: 'ready' | 'unverified' | 'needs-authorization' | 'unreachable'
  updatedAt: string
  deletedAt: string | null
}
export type SaveCloudConnection = Omit<
  CloudConnection,
  'ownerId' | 'version' | 'status' | 'updatedAt' | 'deletedAt'
> & {
  expectedVersion: number
  runtimeKeyEnvelope: ResourceKeyEnvelope
}

export type CloudScheduleConfig = {
  name: string
  prompt: string
  timezone: string
  cadence: { type: 'daily'; hour: number; minute: number } | { type: 'interval'; minutes: number }
  conversationId?: string
}
export type CloudSchedule = {
  id: string
  agentId: string
  version: number
  keyEpoch: number
  enabled: boolean
  config: ScopedCiphertext
  nextRunAt: string | null
  lastRunAt: string | null
  errorCode: string | null
  retryAt: string | null
  createdAt: string
  updatedAt: string
}
export type SaveCloudSchedule = Pick<CloudSchedule, 'id' | 'agentId' | 'keyEpoch' | 'enabled' | 'config'> & {
  expectedVersion: number
}

export type ArtifactManifest = {
  title: string
  mediaType: string
  files: { path: string; mediaType: string; size: number }[]
}
export type CloudArtifact = {
  id: string
  ownerId: string
  currentRevisionId: string | null
  keyEpoch: number
  ownerKeyEnvelope: ResourceKeyEnvelope
  createdAt: string
  deletedAt: string | null
}
export type CloudArtifactRevision = {
  id: string
  artifactId: string
  parentRevisionId: string | null
  keyEpoch: number
  manifest: ScopedCiphertext
  byteLength: number
  conflict: boolean
  createdAt: string
}
export type CloudArtifactState = { artifact: CloudArtifact; revisions: CloudArtifactRevision[] }

/** The stable data scope of an owner's configured cloud agent. */
export const cloudAgentScope = (agentId: string): string => `agent:${agentId}`
/** The independent data scope of a reusable cloud connection. */
export const cloudConnectionScope = (connectionId: string): string => `connection:${connectionId}`
/** The independent data scope of a shared artifact. */
export const cloudArtifactScope = (artifactId: string): string => `artifact:${artifactId}`

/** A capability granted to one cloud agent for the artifact's current key epoch. */
export type CloudArtifactGrant = { agentId: string; keyEpoch: number; canWrite: boolean; revokedAt: string | null }
