/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudConversationState } from '@shared/cloud-agent/contracts'

export type CloudProjection = {
  id: string
  kind: string
  parentId: string | null
  payload: string
  updatedAt: string
  deletedAt: string | null
}
type RecordValue = {
  id: string
  version?: number
  revision?: number
  status?: string
  updatedAt?: string
  createdAt?: string
  deletedAt?: string | null
}

/** Merge server records by version/revision before time, retaining server tombstones. */
export const mergeCloudRecords = (cached: RecordValue[], projections: CloudProjection[]): RecordValue[] => {
  const merged = new Map(cached.map((record) => [record.id, record]))
  for (const projection of projections) {
    const record = JSON.parse(projection.payload) as RecordValue
    const previous = merged.get(record.id)
    // Approval decisions are terminal; a delayed pending projection cannot undo one.
    if (
      projection.kind === 'approval' &&
      previous?.status &&
      previous.status !== 'pending' &&
      record.status === 'pending'
    ) {
      continue
    }
    const newerVersion = (record.version ?? record.revision ?? 0) - (previous?.version ?? previous?.revision ?? 0)
    const newerTime = (record.updatedAt ?? projection.updatedAt) >= (previous?.updatedAt ?? previous?.createdAt ?? '')
    if (!previous || newerVersion > 0 || (newerVersion === 0 && newerTime)) {
      merged.set(record.id, { ...record, ...(projection.deletedAt ? { deletedAt: projection.deletedAt } : {}) })
    }
  }
  return [...merged.values()].filter((record) => !record.deletedAt)
}

/** Rebuild API read shapes from independently replicated encrypted records. */
export const reconstructCloudRead = (resource: string, rows: CloudProjection[], cached: unknown): unknown => {
  const select = (kind: string, parentId?: string) =>
    rows.filter((row) => row.kind === kind && (parentId === undefined || row.parentId === parentId))
  const cachedObject = (cached ?? {}) as Record<string, unknown>
  const list = (kind: string, field: string, parentId?: string) =>
    mergeCloudRecords((cachedObject[field] ?? []) as RecordValue[], select(kind, parentId))
  const direct = (kind: string, id: string, field: string) => {
    const old = cachedObject[field] as RecordValue | undefined
    return mergeCloudRecords(
      old ? [old] : [],
      select(kind).filter((row) => (JSON.parse(row.payload) as RecordValue).id === id),
    )[0]
  }
  if (resource === 'identity') {
    const identity = select('identity')
      .filter((row) => !row.deletedAt)
      .at(-1)
    return identity ? JSON.parse(identity.payload) : cached
  }
  if (resource === 'agents') {
    return { agents: list('agent', 'agents') }
  }
  if (resource === 'connections') {
    return { connections: list('connection', 'connections') }
  }
  if (resource === 'artifacts') {
    return { artifacts: list('artifact', 'artifacts') }
  }
  const children = /^agents\/([^/]+)\/(conversations|schedules)$/.exec(resource)
  if (children) {
    return {
      [children[2]]: list(children[2] === 'conversations' ? 'conversation' : 'schedule', children[2], children[1]),
    }
  }
  const conversation = /^conversations\/([^/]+)$/.exec(resource)
  if (conversation) {
    const record = direct('conversation', conversation[1], 'conversation')
    if (!record) {
      return cached
    }
    const messages = list('message', 'messages', record.id) as CloudConversationState['messages']
    return {
      conversation: record,
      runs: list('run', 'runs', record.id),
      messages,
      approvals: list('approval', 'approvals', record.id),
      cursor: Math.max(0, ...messages.map((message) => message.sequence)),
    }
  }
  const artifact = /^artifacts\/([^/]+)$/.exec(resource)
  if (artifact) {
    const record = direct('artifact', artifact[1], 'artifact')
    return record ? { artifact: record, revisions: list('revision', 'revisions', record.id) } : cached
  }
  return cached
}
