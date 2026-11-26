/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { providerConnectionSecretsTable as secrets } from '@/db/tables'
import { getOtariAuthorizationOrigin, revokeOtariToken } from '@/lib/otari-auth'
import { writeProviderCredentials } from './credentials'
import { withProviderOAuthLock } from './oauth-session'
import type { ProviderCredentials } from './types'

const id = 'oauth:otari'

/** Use the locally approved routing identity, never a URL changed by remote metadata sync. */
const readSession = async (db: AnyDrizzleDatabase) => {
  const row = await db.select().from(secrets).where(eq(secrets.id, id)).get()
  const credentials = JSON.parse(row?.credentials ?? '{}') as ProviderCredentials
  const binding = row?.binding ? (JSON.parse(row.binding) as [string, string, string | null]) : null
  const token = credentials.access_token ?? credentials.apiKey
  return {
    row,
    credentials,
    authorization:
      token && binding?.[0] === 'otari' && binding[1] === 'oauth' && binding[2]
        ? { token, origin: getOtariAuthorizationOrigin(binding[2]) }
        : null,
  }
}

/** Revoke before replacing or clearing a grant. Caller holds the provider lock across its whole mutation. */
export const revokeStoredOtariAuthorization = async (
  db: AnyDrizzleDatabase,
  { disconnect = false }: { disconnect?: boolean } = {},
): Promise<void> => {
  const previous = await readSession(db)
  if (previous.authorization) {
    // Keep the credential available for retry when server-side revocation fails.
    await revokeOtariToken(previous.authorization.origin, previous.authorization.token)
  }
  await db.transaction(async (tx) => {
    const current = await readSession(tx)
    const sameSession = previous.authorization
      ? current.authorization?.token === previous.authorization.token && current.row?.binding === previous.row?.binding
      : current.row?.credentials === previous.row?.credentials && current.row?.binding === previous.row?.binding
    if (!sameSession) {
      throw new Error('Otari session changed during revocation')
    }
    if (disconnect) {
      await writeProviderCredentials(tx, id, { sessionRevision: crypto.randomUUID() }, null)
    } else if (previous.authorization) {
      // A cancelled replacement cannot restore a revoked key. Keep its revision for the guarded save.
      await writeProviderCredentials(tx, id, { ...current.credentials, reauth_required: true }, current.row!.binding)
    }
  })
}

/** Revoke an issued grant only if it never became the saved session, including cancelled saves. */
export const discardOtariAuthorization = (db: AnyDrizzleDatabase, origin: string, token: string): Promise<void> =>
  withProviderOAuthLock(id, async () => {
    const current = await readSession(db)
    if (current.authorization?.token === token && current.authorization.origin === origin) {
      return
    }
    await revokeOtariToken(origin, token)
  })

/** Reauthorizing the same saved grant must not revoke it before the metadata update. */
export const isCurrentOtariAuthorization = async (db: AnyDrizzleDatabase, url: string | null, token: string) => {
  const current = await readSession(db)
  return current.authorization?.token === token && current.authorization.origin === getOtariAuthorizationOrigin(url)
}
