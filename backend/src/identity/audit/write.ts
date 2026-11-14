/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { auditEvent } from '@/db/schema'
import type { AuthAdapter } from '../access'
import { getCurrentOrganizationId } from '../current-organization'
import type { AuditAction, AuditActorType, AuditOutcome } from './events'

/** What an audit event records. Never put secrets here: credential and key ids, never their values. */
export type AuditEventInput = {
  action: AuditAction
  outcome: AuditOutcome
  actor: { type: AuditActorType; id?: string | null }
  target?: { type: string; id?: string | null }
  reason?: string | null
  connectionId?: string | null
  credentialId?: string | null
  requestId?: string | null
  reportSource?: 'server' | 'client'
  changes?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  /** Sign-in events only. */
  ipAddress?: string | null
  userAgent?: string | null
}

const toAuditRow = (event: AuditEventInput) => ({
  id: crypto.randomUUID(),
  orgId: getCurrentOrganizationId(),
  occurredAt: new Date(),
  action: event.action,
  outcome: event.outcome,
  reason: event.reason ?? null,
  actorType: event.actor.type,
  actorId: event.actor.id ?? null,
  targetType: event.target?.type ?? null,
  targetId: event.target?.id ?? null,
  connectionId: event.connectionId ?? null,
  credentialId: event.credentialId ?? null,
  requestId: event.requestId ?? null,
  reportSource: event.reportSource ?? 'server',
  changes: event.changes ?? null,
  metadata: event.metadata ?? null,
  ipAddress: event.ipAddress ?? null,
  userAgent: event.userAgent ?? null,
})

/**
 * Write an audit event with Drizzle. Pass the transaction that makes the change, so the change
 * and its event commit or roll back together.
 */
export const insertAuditEvent = async (tx: QueryableDatabase, event: AuditEventInput) => {
  await tx.insert(auditEvent).values(toAuditRow(event))
}

/**
 * Write an audit event through the Better Auth adapter, from a hook or a SCIM callback. Pass
 * `getCurrentAdapter(...)` so the event joins the transaction the change runs in.
 */
export const createAuditEvent = async (adapter: AuthAdapter, event: AuditEventInput) => {
  await adapter.create({ model: 'auditEvent', data: toAuditRow(event), forceAllowId: true })
}

/**
 * Record an attempt that failed or was denied. A failed attempt's own transaction rolls back, so
 * this must run once it has ended, on the root database or adapter, never inside it.
 */
export const recordFailedAttempt = async (
  database: QueryableDatabase,
  event: AuditEventInput & { outcome: 'failure' | 'denied' },
) => insertAuditEvent(database, event)
