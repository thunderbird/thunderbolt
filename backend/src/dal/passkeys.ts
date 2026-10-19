/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { passkey } from '@/db/auth-schema'
import { encryptionMetadataTable } from '@/db/encryption-schema'
import { and, eq } from 'drizzle-orm'

/** Whether the user already has a passkey (the account is limited to one). */
export const userHasPasskey = async (database: QueryableDatabase, userId: string): Promise<boolean> => {
  const rows = await database.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1)
  return rows.length > 0
}

/** Whether the user's passkey row `passkeyId` is the one holding the account's E2EE passkey slot. */
export const passkeyHoldsSyncSlot = async (
  database: QueryableDatabase,
  userId: string,
  passkeyId: string,
): Promise<boolean> => {
  const rows = await database
    .select({ id: passkey.id })
    .from(passkey)
    .innerJoin(
      encryptionMetadataTable,
      and(
        eq(encryptionMetadataTable.userId, passkey.userId),
        eq(encryptionMetadataTable.passkeyCredentialId, passkey.credentialID),
      ),
    )
    .where(and(eq(passkey.id, passkeyId), eq(passkey.userId, userId)))
    .limit(1)
  return rows.length > 0
}

/** Whether `credentialId` names one of the user's registered passkeys. */
export const isUserPasskeyCredential = async (
  database: QueryableDatabase,
  userId: string,
  credentialId: string,
): Promise<boolean> => {
  const rows = await database
    .select({ id: passkey.id })
    .from(passkey)
    .where(and(eq(passkey.credentialID, credentialId), eq(passkey.userId, userId)))
    .limit(1)
  return rows.length > 0
}
