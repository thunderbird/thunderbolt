/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { TinfoilCredentials } from './tinfoil-auth'

type Provider = 'openrouter' | 'tinfoil' | 'otari'
export type ProviderConnectionAttempt = { provider: Provider; revision: string }
export type ProviderAuthorization = {
  attempt: ProviderConnectionAttempt
  tinfoilCredentials?: TinfoilCredentials
}

/** Capture before authorization or verification, not when its result is ready to save. */
export const getProviderConnectionAttempt = async (
  db: AnyDrizzleDatabase,
  provider: Provider,
): Promise<ProviderConnectionAttempt> => {
  const row = await getIntegrationCredentials(db, provider)
  // Legacy sessions have no generation; their snapshot still detects disconnects.
  return { provider, revision: row?.credentials.sessionRevision ?? JSON.stringify(row) }
}

/** Reject results superseded by another window's disconnect, toggle, or connection. */
export const assertProviderConnectionAttemptCurrent = async (
  db: AnyDrizzleDatabase,
  attempt: ProviderConnectionAttempt,
) => {
  if ((await getProviderConnectionAttempt(db, attempt.provider)).revision !== attempt.revision) {
    throw new Error('Provider connection changed during authorization. Start a new connection.')
  }
}

/** Call in the connection mutation's transaction so even disconnected→connected→disconnected invalidates old work. */
export const invalidateProviderConnectionAttempts = async (db: AnyDrizzleDatabase, provider: Provider) => {
  const row = await getIntegrationCredentials(db, provider)
  await saveIntegrationCredentials(
    db,
    provider,
    { access_token: '', ...row?.credentials, sessionRevision: crypto.randomUUID() },
    row?.enabled ?? false,
  )
}

/** Persist credentials and advance the generation inside the caller's model transaction. */
export const saveProviderAuthorization = async (db: AnyDrizzleDatabase, authorization: ProviderAuthorization) => {
  await assertProviderConnectionAttemptCurrent(db, authorization.attempt)
  if (authorization.tinfoilCredentials) {
    await saveIntegrationCredentials(db, 'tinfoil', authorization.tinfoilCredentials, true)
  }
  await invalidateProviderConnectionAttempts(db, authorization.attempt.provider)
}
