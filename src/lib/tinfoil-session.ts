/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { getDb } from '@/db/database'
import { getAllModels, updateModelInTransaction } from '@/dal/models'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { tinfoilAuth, TinfoilReauthorizationError, type TinfoilCredentials } from './tinfoil-auth'
import { providerConnectionsTable, providerConnectionSecretsTable, integrationsSecretsTable } from '@/db/tables'
import type { ProviderCredentials } from '@/providers/types'
import { eq } from 'drizzle-orm'
import { writeProviderCredentials } from '@/providers/credentials'
import { getIdentitySignal } from './identity-lifetime'

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

/** Cleanup owns local grants even when synced metadata has disabled their inference binding. */
const readStoredTinfoilAuthorization = async (db: AnyDrizzleDatabase) => {
  const secret = await db
    .select()
    .from(providerConnectionSecretsTable)
    .where(eq(providerConnectionSecretsTable.id, 'oauth:tinfoil'))
    .get()
  if (secret) {
    return { secret, credentials: JSON.parse(secret.credentials ?? '{}') as ProviderCredentials }
  }
  return { secret, credentials: (await getIntegrationCredentials(db, 'tinfoil'))?.credentials }
}

/** A rotating token belongs to the same grant even after another window refreshes it. */
const sameAuthorization = (
  current: Pick<ProviderCredentials, 'access_token' | 'refresh_token' | 'authorizationId'>,
  incoming: Pick<ProviderCredentials, 'access_token' | 'refresh_token' | 'authorizationId'>,
): boolean =>
  Boolean(current.authorizationId && current.authorizationId === incoming.authorizationId) ||
  Boolean(current.access_token && current.access_token === incoming.access_token) ||
  Boolean(current.refresh_token && current.refresh_token === incoming.refresh_token)

/** Revoke the replaced grant while holding the session lock, before committing its replacement. */
export const revokeReplacedTinfoilAuthorization = async (
  db: AnyDrizzleDatabase,
  incoming: Pick<TinfoilCredentials, 'access_token' | 'refresh_token' | 'authorizationId'>,
  signal?: AbortSignal,
  auth = tinfoilAuth,
): Promise<void> => {
  const { credentials: previous } = await readStoredTinfoilAuthorization(db)
  if (!previous?.access_token || sameAuthorization(previous, incoming)) {
    return
  }
  signal?.throwIfAborted()
  // A failed revoke leaves the old credential available for retry.
  await auth.revoke(previous.refresh_token ?? previous.access_token)
  // Cancellation or a failed replacement cannot make the revoked session usable again.
  // Retire this grant even if its enabled state or tokens changed during the request.
  await db.transaction(async (tx) => {
    const current = await readStoredTinfoilAuthorization(tx)
    if (!current.credentials || !sameAuthorization(current.credentials, previous)) {
      throw new Error('Tinfoil connection changed during revocation')
    }
    const credentials = { ...current.credentials, reauth_required: true }
    if (current.secret) {
      await writeProviderCredentials(tx, current.secret.id, credentials, current.secret.binding)
      return
    }
    await tx
      .update(integrationsSecretsTable)
      .set({ credentials: JSON.stringify(credentials) })
      .where(eq(integrationsSecretsTable.provider, 'tinfoil'))
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
  getAccessToken: () => {
    const signal = getIdentitySignal()
    return deps.lock(async () => {
      signal.throwIfAborted()
      const db = deps.db()
      // Re-read after acquiring the lock; another window may have rotated or disconnected.
      const row = await getIntegrationCredentials(db, 'tinfoil')
      signal.throwIfAborted()
      const current = row?.credentials
      if (!row?.enabled || !current?.access_token || current.reauth_required) {
        throw new TinfoilReauthorizationError()
      }
      const saveRefresh = (credentials: typeof current) =>
        db.transaction(async (tx) => {
          signal.throwIfAborted()
          const latest = await getIntegrationCredentials(tx, 'tinfoil')
          signal.throwIfAborted()
          if (!latest?.enabled || JSON.stringify(latest.credentials) !== JSON.stringify(current)) {
            throw new Error('Tinfoil connection changed during token refresh')
          }
          await saveIntegrationCredentials(tx, 'tinfoil', credentials, true, true)
          signal.throwIfAborted()
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
        await saveRefresh({ ...current, ...tokens })
        const latest = await getIntegrationCredentials(db, 'tinfoil')
        signal.throwIfAborted()
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
    })
  },
  setEnabled: (enabled: boolean) =>
    deps.lock(() => deps.db().transaction((tx) => setTinfoilSessionEnabledInTransaction(tx, enabled))),
  discardAuthorization: (credentials: Pick<TinfoilCredentials, 'access_token' | 'refresh_token' | 'authorizationId'>) =>
    deps.lock(async () => {
      const current = await readStoredTinfoilAuthorization(deps.db())
      if (current.credentials && sameAuthorization(current.credentials, credentials)) {
        return
      }
      await deps.auth.revoke(credentials.refresh_token ?? credentials.access_token)
    }),
  disconnect: () =>
    deps.lock(async () => {
      const db = deps.db()
      const row = await readStoredTinfoilAuthorization(db)
      if (row.credentials?.access_token) {
        // Keep the connection available for retry if server-side revocation fails.
        await deps.auth.revoke(row.credentials.refresh_token ?? row.credentials.access_token)
      }
      await db.transaction(async (tx) => {
        const current = await readStoredTinfoilAuthorization(tx)
        const unchanged = row.credentials?.access_token
          ? current.credentials && sameAuthorization(current.credentials, row.credentials)
          : JSON.stringify(current) === JSON.stringify(row)
        if (!unchanged) {
          throw new Error('Tinfoil connection changed during revocation')
        }
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
