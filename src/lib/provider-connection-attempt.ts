/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { TinfoilCredentials } from './tinfoil-auth'
import { connectionFingerprint, getProviderConnectionRevision } from '@/providers/revision'

import type { OAuthProviderType as Provider } from '@/providers/types'
type LegacyProvider = 'openrouter' | 'tinfoil' | 'otari'
export type ProviderConnectionAttempt<P extends Provider = LegacyProvider> = { provider: P; revision: string }
export type ProviderAuthorization = {
  attempt: ProviderConnectionAttempt
  tinfoilCredentials?: TinfoilCredentials
}

/** Capture before authorization or verification, not when its result is ready to save. */
export const getProviderConnectionAttempt = async <P extends Provider>(
  db: AnyDrizzleDatabase,
  provider: P,
): Promise<ProviderConnectionAttempt<P>> => {
  const revision = await getProviderConnectionRevision(db, `oauth:${provider}`)
  if (revision) {
    return { provider, revision }
  }
  const row =
    provider === 'openrouter' || provider === 'tinfoil' || provider === 'otari'
      ? await getIntegrationCredentials(db, provider)
      : null
  const legacy = row?.credentials.sessionRevision
    ? { revision: row.credentials.sessionRevision, enabled: row.enabled }
    : row
  return { provider, revision: await connectionFingerprint(legacy) }
}

/** Reject results superseded by another window's disconnect, toggle, or connection. */
export const assertProviderConnectionAttemptCurrent = async (
  db: AnyDrizzleDatabase,
  attempt: ProviderConnectionAttempt<Provider>,
) => {
  if ((await getProviderConnectionAttempt(db, attempt.provider)).revision !== attempt.revision) {
    throw new Error('Provider connection changed during authorization. Start a new connection.')
  }
}

/** Call in the connection mutation's transaction so even disconnected→connected→disconnected invalidates old work. */
export const invalidateProviderConnectionAttempts = async (db: AnyDrizzleDatabase, provider: LegacyProvider) => {
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
