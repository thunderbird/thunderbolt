/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { providerConnectionsTable as connections, providerConnectionSecretsTable as secrets } from '@/db/tables'

/** Fingerprint state without persisting a credential in OAuth or verification handoffs. */
export const connectionFingerprint = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Read the generation even when disconnected or removed, detecting stale asynchronous saves. */
export const getProviderConnectionRevision = async (db: AnyDrizzleDatabase, id: string): Promise<string | null> => {
  const row = await db
    .select({
      provider: connections.provider,
      name: connections.name,
      url: connections.url,
      authMethod: connections.authMethod,
      enabled: connections.enabled,
      deletedAt: connections.deletedAt,
      updatedAt: connections.updatedAt,
      revision: sql<string | null>`json_extract(${secrets.credentials}, '$.sessionRevision')`,
    })
    .from(connections)
    .leftJoin(secrets, eq(connections.id, secrets.id))
    .where(eq(connections.id, id))
    .get()
  return row ? connectionFingerprint(row) : null
}
