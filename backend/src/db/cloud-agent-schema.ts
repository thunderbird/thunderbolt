/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { ResourceKeyEnvelope, ResourcePublicKey, ScopedCiphertext } from '@shared/cloud-agent/crypto'
import type { CloudRunStatus } from '@shared/cloud-agent/contracts'
import { user } from './auth-schema'

const owned = () =>
  text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })
const created = () => timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow()
const updated = () => timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull().defaultNow()
const cipher = (name: string) => jsonb(name).$type<ScopedCiphertext>().notNull()
const envelope = (name: string) => jsonb(name).$type<ResourceKeyEnvelope>().notNull()

export const cloudIdentities = pgTable('cloud_identities', {
  userId: owned().primaryKey(),
  publicKey: jsonb('public_key').$type<ResourcePublicKey>().notNull(),
  privateRecord: jsonb('private_record').$type<Record<string, unknown>>().notNull(),
  createdAt: created(),
})

export const cloudAgents = pgTable(
  'cloud_agents',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    version: integer('version').notNull().default(1),
    keyEpoch: integer('key_epoch').notNull(),
    saveDigest: text('save_digest'),
    enabled: boolean('enabled').notNull().default(true),
    config: cipher('config'),
    ownerKeyEnvelope: envelope('owner_key_envelope'),
    runtimeKeyEnvelope: envelope('runtime_key_envelope'),
    createdAt: created(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [index('cloud_agents_owner').on(table.userId)],
)

export const cloudConnections = pgTable(
  'cloud_connections',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    version: integer('version').notNull().default(1),
    credentialVersion: integer('credential_version').notNull().default(1),
    keyEpoch: integer('key_epoch').notNull(),
    saveDigest: text('save_digest'),
    enabled: boolean('enabled').notNull().default(true),
    config: cipher('config'),
    ownerKeyEnvelope: envelope('owner_key_envelope'),
    runtimeKeyEnvelope: envelope('runtime_key_envelope'),
    status: text('status').notNull().default('unverified'),
    createdAt: created(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [index('cloud_connections_owner').on(table.userId)],
)

export const cloudConversations = pgTable(
  'cloud_conversations',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    agentId: text('agent_id')
      .notNull()
      .references(() => cloudAgents.id),
    piConversationId: integer('pi_conversation_id'),
    createdAt: created(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [index('cloud_conversations_agent').on(table.agentId)],
)

export const cloudRuns = pgTable(
  'cloud_runs',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    agentId: text('agent_id')
      .notNull()
      .references(() => cloudAgents.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => cloudConversations.id),
    commandId: text('command_id').notNull(),
    commandDigest: text('command_digest').notNull(),
    content: cipher('content'),
    keyEpoch: integer('key_epoch').notNull(),
    configVersion: integer('config_version').notNull(),
    config: cipher('config'),
    status: text('status').$type<CloudRunStatus>().notNull().default('queued'),
    piSubmissionId: integer('pi_submission_id'),
    errorCode: text('error_code'),
    reservedMicros: integer('reserved_micros').notNull().default(0),
    spentMicros: integer('spent_micros').notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (table) => [
    uniqueIndex('cloud_runs_command').on(table.userId, table.commandId),
    index('cloud_runs_conversation').on(table.conversationId),
    index('cloud_runs_status').on(table.status),
  ],
)

export const cloudMessages = pgTable(
  'cloud_messages',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => cloudConversations.id),
    runId: text('run_id')
      .notNull()
      .references(() => cloudRuns.id),
    sequence: integer('sequence').notNull(),
    revision: integer('revision').notNull().default(1),
    keyEpoch: integer('key_epoch').notNull(),
    content: cipher('content'),
    createdAt: created(),
  },
  (table) => [index('cloud_messages_conversation').on(table.conversationId, table.sequence)],
)

export const cloudApprovals = pgTable(
  'cloud_approvals',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    agentId: text('agent_id')
      .notNull()
      .references(() => cloudAgents.id),
    runId: text('run_id')
      .notNull()
      .references(() => cloudRuns.id),
    callId: text('call_id').notNull(),
    argumentDigest: text('argument_digest').notNull(),
    keyEpoch: integer('key_epoch').notNull(),
    payload: cipher('payload'),
    status: text('status').notNull().default('pending'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (table) => [uniqueIndex('cloud_approvals_call').on(table.runId, table.callId)],
)

export const cloudSchedules = pgTable(
  'cloud_schedules',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    agentId: text('agent_id')
      .notNull()
      .references(() => cloudAgents.id),
    version: integer('version').notNull().default(1),
    keyEpoch: integer('key_epoch').notNull(),
    saveDigest: text('save_digest'),
    enabled: boolean('enabled').notNull().default(true),
    config: cipher('config'),
    nextRunAt: timestamp('next_run_at', { mode: 'string', withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { mode: 'string', withTimezone: true }),
    activeRunId: text('active_run_id'),
    errorCode: text('error_code'),
    retryAt: timestamp('retry_at', { mode: 'string', withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (table) => [index('cloud_schedules_due').on(table.nextRunAt)],
)

export const cloudArtifacts = pgTable(
  'cloud_artifacts',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    currentRevisionId: text('current_revision_id'),
    keyEpoch: integer('key_epoch').notNull(),
    ownerKeyEnvelope: envelope('owner_key_envelope'),
    createdAt: created(),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [index('cloud_artifacts_owner').on(table.userId)],
)

export const cloudArtifactRevisions = pgTable(
  'cloud_artifact_revisions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => cloudArtifacts.id),
    userId: owned(),
    parentRevisionId: text('parent_revision_id'),
    keyEpoch: integer('key_epoch').notNull(),
    manifest: cipher('manifest'),
    objectKey: text('object_key').notNull(),
    digest: text('digest').notNull(),
    byteLength: integer('byte_length').notNull(),
    conflict: boolean('conflict').notNull().default(false),
    createdAt: created(),
  },
  (table) => [index('cloud_artifact_revisions_artifact').on(table.artifactId)],
)

export const cloudArtifactGrants = pgTable(
  'cloud_artifact_grants',
  {
    artifactId: text('artifact_id')
      .notNull()
      .references(() => cloudArtifacts.id),
    recipientId: text('recipient_id').notNull(),
    recipientKind: text('recipient_kind').notNull(),
    keyEpoch: integer('key_epoch').notNull(),
    keyEnvelope: envelope('key_envelope'),
    canWrite: boolean('can_write').notNull().default(false),
    createdAt: created(),
    revokedAt: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.recipientId, table.keyEpoch] })],
)

export const cloudBlobCleanup = pgTable('cloud_blob_cleanup', {
  objectKey: text('object_key').primaryKey(),
  createdAt: created(),
  deleteAfter: timestamp('delete_after', { mode: 'string', withTimezone: true }).notNull(),
})

// A read-only projection, rebuilt from authoritative application records after a crash.
export const cloudAgentProjections = pgSchema('powersync').table(
  'cloud_agent_projections',
  {
    id: text('id').primaryKey(),
    userId: owned(),
    kind: text('kind').notNull(),
    parentId: text('parent_id'),
    payload: text('payload').notNull(),
    updatedAt: updated(),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [index('cloud_agent_projections_user_id').on(table.userId)],
)

/** One single-use authorization attempt per connection; verifier and issuer binding remain scoped ciphertext. */
export const cloudConnectionOAuth = pgTable('cloud_connection_oauth', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => cloudConnections.id, { onDelete: 'cascade' }),
  userId: owned(),
  stateDigest: text('state_digest').notNull().unique(),
  connectionVersion: integer('connection_version').notNull(),
  keyEpoch: integer('key_epoch').notNull(),
  payload: cipher('payload'),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  createdAt: created(),
})
