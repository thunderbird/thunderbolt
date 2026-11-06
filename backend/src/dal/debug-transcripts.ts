/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { debugTranscriptClientsTable, debugTranscriptsTable } from '@/db/debug-transcript-schema'
import { selfDebugTranscriptClientId } from '@/debug-transcripts/client-key'
import { eq } from 'drizzle-orm'

/** Persist one transcript accepted by the intake. */
export const createDebugTranscript = async (
  database: typeof DbType,
  transcript: typeof debugTranscriptsTable.$inferInsert,
) => database.insert(debugTranscriptsTable).values(transcript)

/** Resolve a client from its key hash. Returns revoked clients too so the caller can answer 403. */
export const findDebugTranscriptClientByKeyHash = async (database: typeof DbType, keyHash: string) => {
  const [client] = await database
    .select({ id: debugTranscriptClientsTable.id, revokedAt: debugTranscriptClientsTable.revokedAt })
    .from(debugTranscriptClientsTable)
    .where(eq(debugTranscriptClientsTable.keyHash, keyHash))
    .limit(1)
  return client ?? null
}

/** Create or rotate the intake host's own client row from configuration. */
export const upsertSelfDebugTranscriptClient = async (database: typeof DbType, keyHash: string) => {
  await database
    .insert(debugTranscriptClientsTable)
    .values({ id: selfDebugTranscriptClientId, name: 'Thunderbolt', keyHash })
    .onConflictDoUpdate({ target: debugTranscriptClientsTable.id, set: { keyHash } })
}
