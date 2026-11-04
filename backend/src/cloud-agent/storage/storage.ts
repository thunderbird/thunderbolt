/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Context, JsonValue } from '@earendil-works/chord'
import { apply } from '@earendil-works/chord/delta'
import {
  StorageRequestError,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentContent,
  type DocumentCopySource,
  type DocumentCreate,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type Page,
  type ScanOrder,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from '@earendil-works/pi-durable'
import type { RuntimeOwner } from './owner'
import { type QueryParameter, type RuntimeSql } from './owner'
import type { StorageCodec } from './types'

type RecordType = 'conversation' | 'entry' | 'task' | 'submission' | 'document'
type DurableRecord =
  | ConversationRecord
  | EntryRecord
  | TaskRecord<JsonValue, JsonValue, JsonValue>
  | SubmissionRecord
  | DocumentRecord
type RecordRow = { id: string | number; record_type: RecordType; payload: string; commit_seq: string | number }
type RevisionRow = { seq: string | number; kind: 'base' | 'delta'; version: number; payload: string }
type DocumentAction = { create?: DocumentCreate; content?: DocumentContent; copy?: DocumentCopySource; retire: boolean }
type Filter = readonly [column: string, value: QueryParameter]

const safeNumber = (value: string | number): number => {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new Error('Cloud runtime numeric identity exceeds the safe integer range')
  }
  return result
}
const scopeOwner = (scope: DocumentAddress['scope']): number =>
  scope.kind === 'conversation' ? scope.conversationId : scope.kind === 'task' ? scope.taskId : 0
const addressValue = (address: DocumentAddress): string =>
  JSON.stringify([
    address.kind,
    address.scope.kind,
    scopeOwner(address.scope),
    address.key !== undefined,
    address.key ?? '',
  ])
const currentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== 'conversation' || record.history === 'latest'
const alive = (record: DocumentRecord, at: DocumentPoint): boolean =>
  at === 'current'
    ? record.retiredAt === undefined
    : record.createdAt <= at && (record.retiredAt === undefined || record.retiredAt > at)

/** PostgreSQL-backed, encrypted Pi storage for one independently recoverable agent namespace. */
export class PostgresNamespaceStorage implements Storage {
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly owner: RuntimeOwner,
    readonly namespace: string,
    private readonly codec: StorageCodec,
    private readonly onClose: () => void,
  ) {}

  async initialize(): Promise<void> {
    await this.owner.run(async (sql) => {
      await sql.query('INSERT INTO cloud_runtime_namespaces (namespace) VALUES ($1) ON CONFLICT DO NOTHING', [
        this.namespace,
      ])
    })
  }

  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>
  commit(writes: readonly StorageWrite[], adopt: (seq: Seq) => void, context: Context): Promise<Seq>
  async commit(
    writes: readonly StorageWrite[],
    contextOrAdopt: Context | ((seq: Seq) => void),
    context?: Context,
  ): Promise<Seq> {
    this.assertOpen()
    const callContext = typeof contextOrAdopt === 'function' ? context : contextOrAdopt
    callContext?.abortSignal?.throwIfAborted()
    // Own the batch before the first await; callers cannot mutate an admitted commit.
    const batch = structuredClone(writes)
    return this.owner.transaction(
      async (sql) => {
        const metadata = (
          await sql.query<{ next_seq: string | number; next_id: string | number }>(
            'SELECT next_seq, next_id FROM cloud_runtime_namespaces WHERE namespace = $1',
            [this.namespace],
          )
        )[0]
        if (!metadata) {
          throw new Error('Cloud runtime namespace metadata is missing')
        }
        const seq = safeNumber(metadata.next_seq) as Seq
        const nextId = await this.validateIds(sql, batch, Number(metadata.next_id))
        const actions = this.documentActions(batch)
        await this.validateDocuments(sql, actions)
        for (const write of batch) {
          if (
            write.type === 'conversation' ||
            write.type === 'entry' ||
            write.type === 'task' ||
            write.type === 'submission'
          ) {
            await this.writeRecord(sql, write.type, write.value, seq)
          }
        }
        for (const [id, action] of actions) {
          await this.writeDocument(sql, id, action, seq)
        }
        await sql.query('UPDATE cloud_runtime_namespaces SET next_id = $2, next_seq = $3 WHERE namespace = $1', [
          this.namespace,
          nextId,
          safeNumber(seq + 1),
        ])
        return seq
      },
      typeof contextOrAdopt === 'function' ? contextOrAdopt : undefined,
    )
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.assertOpen()
    return this.owner.transaction(async (sql) => {
      const row = (
        await sql.query<{ id: string | number }>(
          'UPDATE cloud_runtime_namespaces SET next_id = next_id + 1 WHERE namespace = $1 RETURNING next_id - 1 AS id',
          [this.namespace],
        )
      )[0]
      if (!row) {
        throw new Error('Cloud runtime namespace metadata is missing')
      }
      if (!Number.isSafeInteger(Number(row.id))) {
        throw new Error('ID space is exhausted')
      }
      return safeNumber(row.id) as I
    })
  }

  conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
    return this.read(context, (sql) => this.record<ConversationRecord>(sql, id, 'conversation'))
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    const filters: Filter[] = []
    if (query.ownerConversationId !== undefined) {
      filters.push(['owner_conversation_id', query.ownerConversationId])
    }
    if (query.ownerTaskId !== undefined) {
      filters.push(['owner_task_id', query.ownerTaskId])
    }
    return this.read(context, (sql) =>
      this.scan<ConversationRecord>(sql, 'conversation', query, filters, limit, cursor),
    )
  }

  entry(id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>
  entry(
    first: EntryId | ConversationId,
    second: EntryId | Context,
    third?: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
    const context = third ?? (second as Context)
    const id = (third ? second : first) as EntryId
    return this.read(context, async (sql) => {
      const segments = third ? await this.ancestry(sql, first as ConversationId) : undefined
      const row = (await this.rows(sql, 'entry', [['id', id]]))[0]
      if (!row) {
        return undefined
      }
      const entry = await this.decode<EntryRecord>(row)
      if (segments && !segments.some((segment) => segment.id === entry.conversationId && entry.id <= segment.upper)) {
        return undefined
      }
      return { entry, commitSeq: safeNumber(row.commit_seq) as Seq }
    })
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    context: Context,
  ): Promise<(EntryRecord & { head: EntryId }) | undefined> {
    return this.read(context, async (sql) => {
      const result = await this.entries(sql, { conversationId, maxEntryId: atOrBeforeEntryId }, 1, undefined, true)
      return result.items[0] as (EntryRecord & { head: EntryId }) | undefined
    })
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.read(context, (sql) => this.entries(sql, query, limit, cursor))
  }

  task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
    return this.read(context, (sql) => this.record(sql, id, 'task'))
  }

  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
    return this.read(context, async (sql) => {
      const filters: Filter[] = []
      if (query.conversationId !== undefined) {
        filters.push(['conversation_id', query.conversationId])
      }
      if (query.kind !== undefined) {
        filters.push(['kind_index', await this.index('kind', query.kind)])
      }
      if (query.status !== undefined) {
        filters.push(['status', query.status])
      }
      if (query.abortRequested !== undefined) {
        filters.push(['abort_requested', query.abortRequested])
      }
      if (query.background !== undefined) {
        filters.push(['background', query.background])
      }
      return this.scan(sql, 'task', query, filters, limit, cursor)
    })
  }

  submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
    return this.read(context, (sql) => this.record(sql, id, 'submission'))
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    const filters: Filter[] = []
    if (query.conversationId !== undefined) {
      filters.push(['conversation_id', query.conversationId])
    }
    if (query.status !== undefined) {
      filters.push(['status', query.status])
    }
    return this.read(context, (sql) => this.scan(sql, 'submission', query, filters, limit, cursor))
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.read(context, async (sql) => {
      const row = (
        await this.rows(sql, 'submission', [
          ['conversation_id', conversationId],
          ['request_index', await this.index('request', requestId)],
        ])
      )[0]
      return row ? this.decode<SubmissionRecord>(row) : undefined
    })
  }

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
    return this.read(context, (sql) => this.findDocumentRecord(sql, address, at))
  }

  document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
    return this.read(context, (sql) => this.materialize(sql, id, at))
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.read(context, async (sql) => {
      const filters: Filter[] = [
        ['scope_kind', query.scope.kind],
        ['scope_owner_id', scopeOwner(query.scope)],
      ]
      if (query.kind !== undefined) {
        filters.push(['kind_index', await this.index('kind', query.kind)])
      }
      const membership =
        query.at === 'current'
          ? 'retired_seq IS NULL'
          : `created_seq <= ${safeNumber(query.at)} AND (retired_seq IS NULL OR retired_seq > ${safeNumber(query.at)})`
      return this.scan(sql, 'document', query, filters, limit, cursor, 'ascending', membership)
    })
  }

  close(_context: Context): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closed = true
    this.closePromise = this.owner.run(async () => {}).finally(this.onClose)
    return this.closePromise
  }

  private async read<T>(context: Context, operation: (sql: RuntimeSql) => Promise<T>): Promise<T> {
    this.assertOpen()
    return this.owner.run(async (sql) => {
      context.abortSignal?.throwIfAborted()
      return operation(sql)
    })
  }

  private index(kind: string, value: string): Promise<string> {
    return this.codec.index(JSON.stringify([this.namespace, kind, value]))
  }

  private recordContext(type: RecordType, id: number, seq: number): string {
    return JSON.stringify(['cloud-runtime-record-v1', this.namespace, type, id, seq])
  }

  private revisionContext(id: number, seq: number, kind: string, version: number): string {
    return JSON.stringify(['cloud-runtime-document-v1', this.namespace, id, seq, kind, version])
  }

  private async decode<T>(row: RecordRow): Promise<T> {
    return JSON.parse(
      await this.codec.decode(
        row.payload,
        this.recordContext(row.record_type, safeNumber(row.id), safeNumber(row.commit_seq)),
      ),
    ) as T
  }

  private async record<T>(sql: RuntimeSql, id: number, type: RecordType): Promise<T | undefined> {
    const row = (await this.rows(sql, type, [['id', id]]))[0]
    return row ? this.decode<T>(row) : undefined
  }

  private rows(sql: RuntimeSql, type: RecordType, filters: readonly Filter[], suffix = ''): Promise<RecordRow[]> {
    const values: QueryParameter[] = [this.namespace, type, ...filters.map(([, value]) => value)]
    const clauses = filters.map(([column], index) => `${column} = $${index + 3}`)
    return sql.query<RecordRow>(
      `SELECT id, record_type, payload, commit_seq FROM cloud_runtime_records WHERE namespace = $1 AND record_type = $2${clauses.map((clause) => ` AND ${clause}`).join('')} ${suffix}`,
      values,
    )
  }

  private scanStart(
    query: { order?: ScanOrder },
    cursor: Cursor | undefined,
    fallback: ScanOrder,
  ): { order: ScanOrder; after?: number } {
    if (query.order !== undefined && query.order !== 'ascending' && query.order !== 'descending') {
      throw new StorageRequestError('Invalid scan order')
    }
    if (!cursor) {
      return { order: query.order ?? fallback }
    }
    if (typeof cursor.after !== 'number' || !Number.isSafeInteger(cursor.after)) {
      throw new StorageRequestError('Invalid storage cursor')
    }
    if (cursor.order !== undefined && cursor.order !== 'ascending' && cursor.order !== 'descending') {
      throw new StorageRequestError('Invalid storage cursor')
    }
    if (cursor.namespace !== undefined && cursor.namespace !== this.namespace) {
      throw new StorageRequestError('Foreign storage cursor')
    }
    const order = (cursor.order ?? fallback) as ScanOrder
    if (query.order !== undefined && query.order !== order) {
      throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${query.order}`)
    }
    return { order, after: cursor.after }
  }

  private page<T extends { id: number }>(values: T[], limit: number, order: ScanOrder): Page<T, Cursor> {
    const items = values.slice(0, limit)
    return values.length > limit
      ? { items, next: { after: items[items.length - 1]!.id, order, namespace: this.namespace } }
      : { items }
  }

  private async scan<T extends { id: number }>(
    sql: RuntimeSql,
    type: RecordType,
    query: object & { order?: ScanOrder },
    filters: Filter[],
    limit: number,
    cursor: Cursor | undefined,
    fallback: ScanOrder = 'ascending',
    extra?: string,
  ): Promise<Page<T, Cursor>> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new StorageRequestError('Invalid scan limit')
    }
    const { order, after } = this.scanStart(query, cursor, fallback)
    const range = after === undefined ? '' : ` AND id ${order === 'ascending' ? '>' : '<'} ${safeNumber(after)}`
    const rows = await this.rows(
      sql,
      type,
      filters,
      `${extra ? `AND (${extra})` : ''}${range} ORDER BY id ${order === 'ascending' ? 'ASC' : 'DESC'} LIMIT ${limit + 1}`,
    )
    return this.page(await Promise.all(rows.map((row) => this.decode<T>(row))), limit, order)
  }

  private async ancestry(sql: RuntimeSql, id: ConversationId): Promise<{ id: ConversationId; upper: number }[]> {
    const result: { id: ConversationId; upper: number }[] = []
    const visit = async (current: ConversationId, upper: number): Promise<void> => {
      if (result.some((item) => item.id === current)) {
        throw new Error('Cyclic conversation ancestry')
      }
      const conversation = await this.record<ConversationRecord>(sql, current, 'conversation')
      if (!conversation) {
        throw new StorageRequestError(`Unknown conversation: ${current}`)
      }
      result.push({ id: current, upper })
      if (conversation.parent) {
        await visit(conversation.parent.conversationId, Math.min(upper, conversation.parent.at))
      }
    }
    await visit(id, Number.MAX_SAFE_INTEGER)
    return result
  }

  private async entries(
    sql: RuntimeSql,
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    headsOnly = false,
  ): Promise<Page<EntryRecord, Cursor>> {
    const segments = await this.ancestry(sql, query.conversationId)
    const visible = segments
      .map((segment) => `(conversation_id = ${safeNumber(segment.id)} AND id <= ${safeNumber(segment.upper)})`)
      .join(' OR ')
    const bounds = [
      query.minEntryId === undefined ? '' : ` AND id >= ${safeNumber(query.minEntryId)}`,
      query.maxEntryId === undefined ? '' : ` AND id <= ${safeNumber(query.maxEntryId)}`,
    ].join('')
    return this.scan(
      sql,
      'entry',
      query,
      [],
      limit,
      cursor,
      'descending',
      `(${visible})${bounds}${headsOnly ? ' AND head_id IS NOT NULL' : ''}`,
    )
  }

  private async findDocumentRecord(
    sql: RuntimeSql,
    address: DocumentAddress,
    at: DocumentPoint,
  ): Promise<DocumentRecord | undefined> {
    const membership =
      at === 'current'
        ? 'retired_seq IS NULL'
        : `created_seq <= ${safeNumber(at)} AND (retired_seq IS NULL OR retired_seq > ${safeNumber(at)})`
    const row = (
      await this.rows(
        sql,
        'document',
        [['address_index', await this.index('address', addressValue(address))]],
        `AND (${membership}) ORDER BY created_seq DESC LIMIT 1`,
      )
    )[0]
    return row ? this.decode<DocumentRecord>(row) : undefined
  }

  private async materialize(sql: RuntimeSql, id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
    const record = await this.record<DocumentRecord>(sql, id, 'document')
    if (!record) {
      return undefined
    }
    if (at !== 'current' && currentOnly(record)) {
      throw new StorageRequestError(`Document ${id} does not retain historical content`)
    }
    if (!alive(record, at)) {
      return undefined
    }
    const upper = at === 'current' ? Number.MAX_SAFE_INTEGER : at
    const base = (
      await sql.query<RevisionRow>(
        "SELECT seq, kind, version, payload FROM cloud_runtime_document_revisions WHERE namespace = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3 ORDER BY seq DESC LIMIT 1",
        [this.namespace, id, upper],
      )
    )[0]
    if (!base) {
      throw new Error(`Document ${id} is missing a required base`)
    }
    const content = await this.decodeRevision(id, base)
    if (content.kind !== 'base') {
      throw new Error(`Document ${id} has an invalid base`)
    }
    const revisions = await sql.query<RevisionRow>(
      'SELECT seq, kind, version, payload FROM cloud_runtime_document_revisions WHERE namespace = $1 AND document_id = $2 AND seq > $3 AND seq <= $4 ORDER BY seq',
      [this.namespace, id, safeNumber(base.seq), upper],
    )
    const value = revisions.length
      ? await revisions.reduce(async (pending, row) => {
          const previous = await pending
          const delta = await this.decodeRevision(id, row)
          if (delta.kind !== 'delta' || delta.version !== base.version) {
            throw new Error(`Document ${id} crosses a stored version boundary without a base`)
          }
          return apply(previous, delta.ops)
        }, Promise.resolve(content.value))
      : content.value
    return { record, version: base.version, value, deltasSinceBase: revisions.length }
  }

  private async decodeRevision(id: DocumentId, row: RevisionRow): Promise<DocumentContent> {
    const content = JSON.parse(
      await this.codec.decode(row.payload, this.revisionContext(id, safeNumber(row.seq), row.kind, row.version)),
    ) as DocumentContent
    if (content.kind !== row.kind || content.version !== row.version) {
      throw new Error('Document revision metadata does not match its authenticated content')
    }
    return content
  }

  private async validateIds(sql: RuntimeSql, writes: readonly StorageWrite[], initialNextId: number): Promise<number> {
    const claimed = new Map<number, RecordType>()
    const nextIds = [initialNextId]
    for (const write of writes) {
      if (write.type === 'document.change' || write.type === 'document.retire') {
        continue
      }
      const document = write.type === 'document.create' || write.type === 'document.copy'
      const id = document ? write.record.id : write.value.id
      const type: RecordType = document ? 'document' : write.type
      safeNumber(id)
      const existing = (
        await sql.query<{ record_type: RecordType }>(
          'SELECT record_type FROM cloud_runtime_records WHERE namespace = $1 AND id = $2',
          [this.namespace, id],
        )
      )[0]?.record_type
      const previous = claimed.get(id)
      if (type === 'conversation' || type === 'entry' || type === 'document') {
        if (existing !== undefined) {
          throw new Error(`ID ${id} already belongs to ${existing}`)
        }
        if (previous !== undefined) {
          throw new Error(`ID ${id} is written more than once`)
        }
      } else {
        if (existing !== undefined && existing !== type) {
          throw new Error(`ID ${id} already belongs to ${existing}`)
        }
        if (previous !== undefined && previous !== type) {
          throw new Error(`ID ${id} is written as two record types`)
        }
      }
      claimed.set(id, type)
      nextIds.push(id + 1)
    }
    return Math.max(...nextIds)
  }

  private documentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
    const actions = new Map<DocumentId, DocumentAction>()
    for (const write of writes) {
      if (
        write.type === 'conversation' ||
        write.type === 'entry' ||
        write.type === 'task' ||
        write.type === 'submission'
      ) {
        continue
      }
      const id = write.type === 'document.create' || write.type === 'document.copy' ? write.record.id : write.id
      const action = actions.get(id) ?? { retire: false }
      actions.set(id, action)
      if (write.type === 'document.retire') {
        if (action.retire) {
          throw new Error(`Document ${id} is retired more than once`)
        }
        action.retire = true
        continue
      }
      if (action.content !== undefined || action.copy !== undefined || action.create !== undefined) {
        throw new Error(`Document ${id} has more than one content command`)
      }
      if (write.type === 'document.create') {
        action.create = write.record
        action.content = write.content
      } else if (write.type === 'document.copy') {
        action.create = write.record
        action.copy = write.source
      } else {
        action.content = write.content
      }
    }
    return actions
  }

  private async validateDocuments(sql: RuntimeSql, actions: Map<DocumentId, DocumentAction>): Promise<void> {
    const liveCounts = new Map<string, number>()
    for (const [id, action] of actions) {
      if (action.copy && actions.has(action.copy.id)) {
        throw new Error(`Document copy ${id} source is changed in the copy batch`)
      }
      const existing = await this.record<DocumentRecord>(sql, id, 'document')
      if (!action.create && !existing) {
        throw new Error(`Unknown document: ${id}`)
      }
      if (action.create && existing) {
        throw new Error(`Document ${id} already exists`)
      }
      if (existing?.retiredAt !== undefined) {
        throw new Error(`Document ${id} is retired`)
      }
      if (action.content?.kind === 'delta') {
        const previous = (
          await sql.query<{ version: number }>(
            'SELECT version FROM cloud_runtime_document_revisions WHERE namespace = $1 AND document_id = $2 ORDER BY seq DESC LIMIT 1',
            [this.namespace, id],
          )
        )[0]
        if (!previous) {
          throw new Error(`Document ${id} delta has no base`)
        }
        if (previous.version !== action.content.version) {
          throw new Error(`Document ${id} version transition requires a base`)
        }
      }
      const record = action.create ?? existing!
      const key = addressValue(record)
      const previousCount = liveCounts.get(key) ?? ((await this.findDocumentRecord(sql, record, 'current')) ? 1 : 0)
      liveCounts.set(
        key,
        previousCount - (action.retire && existing ? 1 : 0) + (action.create && !action.retire ? 1 : 0),
      )
    }
    if ([...liveCounts.values()].some((count) => count > 1)) {
      throw new Error('Document address already has a current incarnation')
    }
  }

  private async writeRecord(sql: RuntimeSql, type: RecordType, record: DurableRecord, seq: Seq): Promise<void> {
    const conversation = type === 'conversation' ? (record as ConversationRecord) : undefined
    const entry = type === 'entry' ? (record as EntryRecord) : undefined
    const task = type === 'task' ? (record as TaskRecord<JsonValue, JsonValue, JsonValue>) : undefined
    const submission = type === 'submission' ? (record as SubmissionRecord) : undefined
    const document = type === 'document' ? (record as DocumentRecord) : undefined
    const kind = task?.kind ?? document?.kind
    const payload = await this.codec.encode(JSON.stringify(record), this.recordContext(type, record.id, seq))
    const parameters: QueryParameter[] = [
      this.namespace,
      record.id,
      type,
      entry?.conversationId ?? task?.conversationId ?? submission?.conversationId ?? null,
      conversation?.owner?.conversationId ?? null,
      conversation?.owner?.taskId ?? null,
      kind === undefined ? null : await this.index('kind', kind),
      task?.state.status ?? submission?.status ?? null,
      task?.abortRequested ?? null,
      task?.background ?? null,
      submission?.requestId === undefined ? null : await this.index('request', submission.requestId),
      document?.scope.kind ?? null,
      document ? scopeOwner(document.scope) : null,
      document ? await this.index('address', addressValue(document)) : null,
      document?.createdAt ?? null,
      document?.retiredAt ?? null,
      entry?.head ?? null,
      seq,
      payload,
    ]
    const columns = [
      'namespace',
      'id',
      'record_type',
      'conversation_id',
      'owner_conversation_id',
      'owner_task_id',
      'kind_index',
      'status',
      'abort_requested',
      'background',
      'request_index',
      'scope_kind',
      'scope_owner_id',
      'address_index',
      'created_seq',
      'retired_seq',
      'head_id',
      'commit_seq',
      'payload',
    ]
    const conflict =
      type === 'conversation' || type === 'entry'
        ? ''
        : ` ON CONFLICT (namespace, id) DO UPDATE SET ${columns
            .slice(2)
            .map((column) => `${column} = EXCLUDED.${column}`)
            .join(', ')}`
    await sql.query(
      `INSERT INTO cloud_runtime_records (${columns.join(', ')}) VALUES (${parameters.map((_, index) => `$${index + 1}`).join(', ')})${conflict}`,
      parameters,
    )
  }

  private async copiedContent(
    sql: RuntimeSql,
    id: DocumentId,
    action: DocumentAction,
  ): Promise<DocumentContent | undefined> {
    if (!action.copy) {
      return action.content
    }
    try {
      const stored = await this.materialize(sql, action.copy.id, action.copy.at)
      const create = action.create!
      if (
        !stored ||
        stored.record.scope.kind !== 'conversation' ||
        create.scope.kind !== 'conversation' ||
        stored.record.kind !== create.kind ||
        stored.record.key !== create.key ||
        stored.record.history !== create.history ||
        stored.record.fork !== create.fork
      ) {
        throw new Error('Fork source does not match the copied record')
      }
      return { kind: 'base', version: stored.version, value: stored.value }
    } catch (error) {
      throw new Error(`Document copy ${id} was rejected`, { cause: error })
    }
  }

  private async writeDocument(sql: RuntimeSql, id: DocumentId, action: DocumentAction, seq: Seq): Promise<void> {
    const content = await this.copiedContent(sql, id, action)
    const existing = action.create ? undefined : await this.record<DocumentRecord>(sql, id, 'document')
    const record = {
      ...(action.create ? { ...action.create, createdAt: seq } : existing!),
      ...(action.retire ? { retiredAt: seq } : {}),
    } as DocumentRecord
    await this.writeRecord(sql, 'document', record, seq)
    if (content) {
      if (content.kind === 'base' && currentOnly(record)) {
        await sql.query('DELETE FROM cloud_runtime_document_revisions WHERE namespace = $1 AND document_id = $2', [
          this.namespace,
          id,
        ])
      }
      const payload = await this.codec.encode(
        JSON.stringify(content),
        this.revisionContext(id, seq, content.kind, content.version),
      )
      await sql.query(
        'INSERT INTO cloud_runtime_document_revisions (namespace, document_id, seq, kind, version, payload) VALUES ($1, $2, $3, $4, $5, $6)',
        [this.namespace, id, seq, content.kind, content.version, payload],
      )
    }
    if (action.retire && currentOnly(record)) {
      await sql.query('DELETE FROM cloud_runtime_document_revisions WHERE namespace = $1 AND document_id = $2', [
        this.namespace,
        id,
      ])
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('PostgresNamespaceStorage is closed')
    }
  }
}
