/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { apikey, identityConnection, invitation, localGroup, orgDomain, orgMembership, user } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'

/** The actor and target types that have something readable to show. */
const labelKinds = [
  'user',
  'api_key',
  'scim_connection',
  'identity_connection',
  'local_group',
  'org_domain',
  'invitation',
] as const

type LabelKind = (typeof labelKinds)[number]

const isLabelKind = (kind: string | null): kind is LabelKind =>
  (labelKinds as readonly (string | null)[]).includes(kind)

type LabelRow = { id: string | null; label: string | null }

type Lookup = (database: typeof DbType, orgId: string, ids: string[]) => Promise<LabelRow[]>

/**
 * One query per kind, each scoped to the org. A user, or an API key's owner, is named only while they're a
 * member: audit events also record people who never joined (a refused sign-in, a non-member probing the
 * admin API), and their name or email isn't the org's to see.
 */
const lookups: Record<LabelKind, Lookup> = {
  user: async (database, orgId, ids) => {
    const rows = await database
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .innerJoin(orgMembership, and(eq(orgMembership.userId, user.id), eq(orgMembership.orgId, orgId)))
      .where(inArray(user.id, ids))
    return rows.map((row) => ({ id: row.id, label: row.name || row.email }))
  },
  api_key: (database, orgId, ids) =>
    database
      .select({ id: apikey.id, label: apikey.name })
      .from(apikey)
      .innerJoin(orgMembership, and(eq(orgMembership.userId, apikey.referenceId), eq(orgMembership.orgId, orgId)))
      .where(inArray(apikey.id, ids)),
  // SCIM events name the identity connection as their actor, not the plugin's SCIM connection.
  scim_connection: (database, orgId, ids) =>
    database
      .select({ id: identityConnection.id, label: identityConnection.name })
      .from(identityConnection)
      .where(and(eq(identityConnection.orgId, orgId), inArray(identityConnection.id, ids))),
  identity_connection: (database, orgId, ids) =>
    database
      .select({ id: identityConnection.id, label: identityConnection.name })
      .from(identityConnection)
      .where(and(eq(identityConnection.orgId, orgId), inArray(identityConnection.id, ids))),
  local_group: (database, orgId, ids) =>
    database
      .select({ id: localGroup.id, label: localGroup.name })
      .from(localGroup)
      .where(and(eq(localGroup.orgId, orgId), inArray(localGroup.id, ids))),
  org_domain: (database, orgId, ids) =>
    database
      .select({ id: orgDomain.id, label: orgDomain.domain })
      .from(orgDomain)
      .where(and(eq(orgDomain.orgId, orgId), inArray(orgDomain.id, ids))),
  invitation: (database, orgId, ids) =>
    database
      .select({ id: invitation.id, label: invitation.email })
      .from(invitation)
      .where(and(eq(invitation.orgId, orgId), inArray(invitation.id, ids))),
}

type LabelledEvent = { actorType: string; actorId: string | null; targetType: string | null; targetId: string | null }

export type AuditLabels = { actorLabel: string | null; targetLabel: string | null }

/**
 * Readable names for a page of events' actors and targets: a person's name (or email), a connection, group,
 * domain or API key's name, an invitation's address. Null where there's none, or the thing is gone.
 */
export const labelAuditEvents = async <T extends LabelledEvent>(
  database: typeof DbType,
  orgId: string,
  events: T[],
): Promise<(T & AuditLabels)[]> => {
  const idsByKind = new Map<LabelKind, Set<string>>()
  const refs = events.flatMap((event) => [
    [event.actorType, event.actorId],
    [event.targetType, event.targetId],
  ])
  for (const [kind, id] of refs) {
    if (isLabelKind(kind) && id) {
      idsByKind.set(kind, (idsByKind.get(kind) ?? new Set<string>()).add(id))
    }
  }

  const labels = new Map<string, string>()
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      for (const row of await lookups[kind](database, orgId, [...ids])) {
        if (row.id && row.label) {
          labels.set(`${kind}:${row.id}`, row.label)
        }
      }
    }),
  )

  const labelOf = (kind: string | null, id: string | null) => (id ? (labels.get(`${kind}:${id}`) ?? null) : null)
  return events.map((event) => ({
    ...event,
    actorLabel: labelOf(event.actorType, event.actorId),
    targetLabel: labelOf(event.targetType, event.targetId),
  }))
}
