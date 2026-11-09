/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { getDb } from '@/db/database'
import { getAllModels, updateModelInTransaction } from '@/dal/models'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { tinfoilAuth, TinfoilReauthorizationError } from './tinfoil-auth'
import { providerConnectionsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { writeProviderCredentials } from '@/providers/credentials'

const lockName = 'thunderbolt-tinfoil-session'
/** A single origin-wide lock protects rotating Tinfoil credentials. */
export const withTinfoilSessionLock = <T>(operation: () => Promise<T>): Promise<T> =>
  navigator.locks.request(lockName, () => operation())

const defaultDependencies = {
  db: getDb,
  auth: tinfoilAuth,
  lock: withTinfoilSessionLock,
  now: Date.now,
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
      const saveRefresh = (credentials: typeof current) =>
        db.transaction(async (tx) => {
          const latest = await getIntegrationCredentials(tx, 'tinfoil')
          if (!latest?.enabled || JSON.stringify(latest.credentials) !== JSON.stringify(current)) {
            throw new Error('Tinfoil connection changed during token refresh')
          }
          await saveIntegrationCredentials(tx, 'tinfoil', credentials, true, true)
        })
      if (current.expires_at && current.expires_at > deps.now() + 60_000) {
        return current.access_token
      }
      if (!current.refresh_token) {
        await saveRefresh({ ...current, reauth_required: true })
        throw new TinfoilReauthorizationError()
      }
      try {
        const tokens = await deps.auth.refresh(current.refresh_token)
        await saveRefresh({ ...tokens, sessionRevision: current.sessionRevision })
        const latest = await getIntegrationCredentials(db, 'tinfoil')
        if (
          !latest?.enabled ||
          latest.credentials.sessionRevision !== current.sessionRevision ||
          latest.credentials.access_token !== tokens.access_token
        ) {
          throw new Error('Tinfoil connection changed during token refresh')
        }
        return tokens.access_token
      } catch (error) {
        if (error instanceof TinfoilReauthorizationError) {
          await saveRefresh({ ...current, reauth_required: true })
        }
        throw error
      }
    }),
  setEnabled: (enabled: boolean) =>
    deps.lock(() => deps.db().transaction((tx) => setTinfoilSessionEnabledInTransaction(tx, enabled))),
  disconnect: () =>
    deps.lock(async () => {
      const db = deps.db()
      const row = await getIntegrationCredentials(db, 'tinfoil')
      if (row?.credentials.access_token) {
        // Keep the connection available for retry if server-side revocation fails.
        await deps.auth.revoke(row.credentials.refresh_token ?? row.credentials.access_token)
      }
      await db.transaction(async (tx) => {
        const connection = await tx
          .select()
          .from(providerConnectionsTable)
          .where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
          .get()
        if (connection) {
          await writeProviderCredentials(tx, connection.id, { sessionRevision: crypto.randomUUID() }, null)
          return
        }
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
