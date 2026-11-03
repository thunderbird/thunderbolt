/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { getAllModels, updateModelInTransaction } from '@/dal/models'
import { getDb } from '@/db/database'
import { tinfoilAuth, TinfoilReauthorizationError } from './tinfoil-auth'

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
        throw new TinfoilReauthorizationError()
      }
      try {
        const tokens = await deps.auth.refresh(current.refresh_token)
        await saveIntegrationCredentials(db, 'tinfoil', tokens, true)
        return tokens.access_token
      } catch (error) {
        if (error instanceof TinfoilReauthorizationError) {
          await saveIntegrationCredentials(db, 'tinfoil', { ...current, reauth_required: true }, true)
        }
        throw error
      }
    }),
  setEnabled: (enabled: boolean) =>
    deps.lock(async () => {
      const db = deps.db()
      await db.transaction(async (tx) => {
        const row = await getIntegrationCredentials(tx, 'tinfoil')
        if (!row?.credentials.access_token || (enabled && row.credentials.reauth_required)) {
          throw new TinfoilReauthorizationError()
        }
        await saveIntegrationCredentials(tx, 'tinfoil', row.credentials, enabled)
        for (const model of await getAllModels(tx)) {
          if (model.oauthProvider === 'tinfoil') {
            await updateModelInTransaction(tx, model.id, { enabled: enabled ? 1 : 0 })
          }
        }
      })
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
        await saveIntegrationCredentials(tx, 'tinfoil', { access_token: '' }, false)
        for (const model of await getAllModels(tx)) {
          if (model.oauthProvider === 'tinfoil') {
            // Keep the account association so reconnect can reuse this model's identity.
            await updateModelInTransaction(tx, model.id, { apiKey: null, oauthProvider: 'tinfoil', enabled: 0 })
          }
        }
      })
    }),
})
export const tinfoilSession = createTinfoilSession()
