/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

export const cloudRuntimeNamespaces = pgTable('cloud_runtime_namespaces', {
  namespace: text('namespace').primaryKey(),
  nextId: bigint('next_id', { mode: 'number' }).notNull().default(2),
  nextSeq: bigint('next_seq', { mode: 'number' }).notNull().default(1),
})

// Only query/routing metadata is plaintext. Complete records are authenticated ciphertext.
export const cloudRuntimeRecords = pgTable(
  'cloud_runtime_records',
  {
    namespace: text('namespace')
      .notNull()
      .references(() => cloudRuntimeNamespaces.namespace, { onDelete: 'cascade' }),
    id: bigint('id', { mode: 'number' }).notNull(),
    recordType: text('record_type').notNull(),
    conversationId: bigint('conversation_id', { mode: 'number' }),
    ownerConversationId: bigint('owner_conversation_id', { mode: 'number' }),
    ownerTaskId: bigint('owner_task_id', { mode: 'number' }),
    kindIndex: text('kind_index'),
    status: text('status'),
    abortRequested: boolean('abort_requested'),
    background: boolean('background'),
    requestIndex: text('request_index'),
    scopeKind: text('scope_kind'),
    scopeOwnerId: bigint('scope_owner_id', { mode: 'number' }),
    addressIndex: text('address_index'),
    createdSeq: bigint('created_seq', { mode: 'number' }),
    retiredSeq: bigint('retired_seq', { mode: 'number' }),
    headId: bigint('head_id', { mode: 'number' }),
    commitSeq: bigint('commit_seq', { mode: 'number' }).notNull(),
    payload: text('payload').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.id] }),
    check(
      'cloud_runtime_record_type',
      sql`${table.recordType} in ('conversation', 'entry', 'task', 'submission', 'document')`,
    ),
    index('cloud_runtime_records_type_id_idx').on(table.namespace, table.recordType, table.id),
    index('cloud_runtime_records_conversation_idx').on(
      table.namespace,
      table.recordType,
      table.conversationId,
      table.id,
    ),
    index('cloud_runtime_records_status_idx').on(table.namespace, table.recordType, table.status, table.id),
    index('cloud_runtime_records_request_idx').on(table.namespace, table.conversationId, table.requestIndex),
    index('cloud_runtime_records_address_idx').on(table.namespace, table.addressIndex, table.createdSeq),
    index('cloud_runtime_records_scope_idx').on(table.namespace, table.scopeKind, table.scopeOwnerId, table.id),
    index('cloud_runtime_records_owner_conversation_idx').on(table.namespace, table.ownerConversationId, table.id),
    index('cloud_runtime_records_owner_task_idx').on(table.namespace, table.ownerTaskId, table.id),
  ],
)

export const cloudRuntimeDocumentRevisions = pgTable(
  'cloud_runtime_document_revisions',
  {
    namespace: text('namespace')
      .notNull()
      .references(() => cloudRuntimeNamespaces.namespace, { onDelete: 'cascade' }),
    documentId: bigint('document_id', { mode: 'number' }).notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    payload: text('payload').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.documentId, table.seq] }),
    check('cloud_runtime_revision_kind', sql`${table.kind} in ('base', 'delta')`),
    index('cloud_runtime_revisions_base_idx').on(table.namespace, table.documentId, table.kind, table.seq),
  ],
)
