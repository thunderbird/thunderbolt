/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { getDb } from '@/db/database'
import { getAllModels, updateModelInTransaction } from '@/dal/models'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { tinfoilAuth, TinfoilReauthorizationError, type TinfoilCredentials } from './tinfoil-auth'

const lockName = 'thunderbolt-tinfoil-session'
/** A single origin-wide lock protects rotating Tinfoil credentials. */
export const withTinfoilSessionLock = <T>(operation: () => Promise<T>): Promise<T> =>
  navigator.locks.request(lockName, operation)

const defaultDependencies = {
  db: getDb,
  auth: tinfoilAuth,
  lock: withTinfoilSessionLock,
  now: Date.now,
}

/** A rotating token belongs to the same grant even after another window refreshes it. */
const sameAuthorization = (
  current: { access_token: string; refresh_token?: string; authorizationId?: string },
  incoming: TinfoilCredentials,
): boolean =>
  Boolean(current.authorizationId && current.authorizationId === incoming.authorizationId) ||
  current.access_token === incoming.access_token ||
  Boolean(current.refresh_token && current.refresh_token === incoming.refresh_token)

/** Revoke the replaced grant while holding the session lock, before committing its replacement. */
export const revokeReplacedTinfoilAuthorization = async (
  db: AnyDrizzleDatabase,
  incoming: TinfoilCredentials,
  signal?: AbortSignal,
  auth = tinfoilAuth,
): Promise<void> => {
  const row = await getIntegrationCredentials(db, 'tinfoil')
  if (!row?.credentials.access_token || sameAuthorization(row.credentials, incoming)) {
    return
  }
  signal?.throwIfAborted()
  // A failed revoke leaves the old credential available for retry.
  await auth.revoke(row.credentials.refresh_token ?? row.credentials.access_token)
  // Cancellation or a failed replacement cannot make the revoked session usable again.
  // Preserve the attempt's snapshot, including legacy rows without an explicit revision.
  await db.transaction(async (tx) => {
    const current = await getIntegrationCredentials(tx, 'tinfoil')
    if (JSON.stringify(current) !== JSON.stringify(row)) {
      throw new Error('Tinfoil connection changed during revocation')
    }
    await saveIntegrationCredentials(
      tx,
      'tinfoil',
      {
        ...row.credentials,
        sessionRevision: row.credentials.sessionRevision ?? JSON.stringify(row),
        reauth_required: true,
      },
      row.enabled,
    )
  })
}

/** Updates OAuth access within a caller-owned transaction and session lock. */
export const setTinfoilSessionEnabledInTransaction = async (
  db: AnyDrizzleDatabase,
  enabled: boolean,
): Promise<void> => {
  const row = await getIntegrationCredentials(db, 'tinfoil')
  if (!row?.credentials.access_token || (enabled && row.credentials.reauth_required)) {
    throw new TinfoilReauthorizationError()
  }
  if (row.enabled !== enabled) {
    await saveIntegrationCredentials(
      db,
      'tinfoil',
      { ...row.credentials, sessionRevision: crypto.randomUUID() },
      enabled,
    )
  }
}

/** Serialize session changes across windows: Tinfoil revokes replayed refresh-token families. */
export const createTinfoilSession = (deps = defaultDependencies) => ({
  getAccessToken: () =>
    deps.lock(async () => {
      const db = deps.db()
      // Re-read after acquiring the lock; another window may have rotated or disconnected.
      const row = await getIntegrationCredentials(db, 'tinfoil')
      const current = row?.credentials
      if (!row?.enabled || !current?.access_token || current.reauth_required) {
        throw new TinfoilReauthorizationError()
      }
      if (current.expires_at && current.expires_at > deps.now() + 60_000) {
        return current.access_token
      }
      if (!current.refresh_token) {
        await saveIntegrationCredentials(db, 'tinfoil', { ...current, reauth_required: true }, true)
        throw new TinfoilReauthorizationError()
      }
      try {
        const tokens = await deps.auth.refresh(current.refresh_token)
        await saveIntegrationCredentials(db, 'tinfoil', { ...current, ...tokens }, true)
        return tokens.access_token
      } catch (error) {
        if (error instanceof TinfoilReauthorizationError) {
          await saveIntegrationCredentials(db, 'tinfoil', { ...current, reauth_required: true }, true)
        }
        throw error
      }
    }),
  setEnabled: (enabled: boolean) =>
    deps.lock(() => deps.db().transaction((tx) => setTinfoilSessionEnabledInTransaction(tx, enabled))),
  discardAuthorization: (credentials: TinfoilCredentials) =>
    deps.lock(async () => {
      const current = await getIntegrationCredentials(deps.db(), 'tinfoil')
      if (current && sameAuthorization(current.credentials, credentials)) {
        return
      }
      await deps.auth.revoke(credentials.refresh_token ?? credentials.access_token)
    }),
  disconnect: () =>
    deps.lock(async () => {
      const db = deps.db()
      const row = await getIntegrationCredentials(db, 'tinfoil')
      if (row?.credentials.access_token) {
        // Keep the connection available for retry if server-side revocation fails.
        await deps.auth.revoke(row.credentials.refresh_token ?? row.credentials.access_token)
      }
      await db.transaction(async (tx) => {
        for (const model of await getAllModels(tx)) {
          if (
            model.provider === 'tinfoil' &&
            model.isSystem !== 1 &&
            model.providerDefault === 1 &&
            !model.oauthProvider
          ) {
            await updateModelInTransaction(tx, model.id, { apiKey: null })
          }
        }
        await saveIntegrationCredentials(
          tx,
          'tinfoil',
          { access_token: '', sessionRevision: crypto.randomUUID() },
          false,
        )
      })
    }),
})
export const tinfoilSession = createTinfoilSession()
