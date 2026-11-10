/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { getDb } from '@/db/database'
import { getAllModels, updateModelInTransaction } from '@/dal/models'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { tinfoilAuth, TinfoilReauthorizationError } from './tinfoil-auth'
import { providerConnectionsTable, providerConnectionSecretsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { credentialBinding, writeProviderCredentials } from '@/providers/credentials'
import { getIdentitySignal } from './identity-lifetime'
import type { ProviderCredentials } from '@/providers/types'
import { getProviderConnectionAttempt } from './provider-connection-attempt'

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

/** Local grant ownership survives metadata removal or changes synced from another device. */
const readStoredAuthorization = async (db: AnyDrizzleDatabase) => {
  const secret = await db
    .select()
    .from(providerConnectionSecretsTable)
    .where(eq(providerConnectionSecretsTable.id, 'oauth:tinfoil'))
    .get()
  if (secret) {
    const bound = secret.binding === credentialBinding({ provider: 'tinfoil', authMethod: 'oauth', url: null })
    const credentials: ProviderCredentials = bound ? JSON.parse(secret.credentials ?? '{}') : {}
    return { secret, legacy: null, credentials }
  }
  const legacy = await getIntegrationCredentials(db, 'tinfoil')
  const credentials: ProviderCredentials = legacy?.credentials ?? {}
  return { secret: null, legacy, credentials }
}

/** Match a saved grant through refresh rotation, with token fallback for older credentials. */
const sameAuthorization = (current: ProviderCredentials, incoming: ProviderCredentials): boolean =>
  Boolean(current.authorizationId && current.authorizationId === incoming.authorizationId) ||
  Boolean(current.access_token && current.access_token === incoming.access_token) ||
  Boolean(current.refresh_token && current.refresh_token === incoming.refresh_token)

/** Retire a replaced grant under the caller's session lock, preserving its guarded save generation. */
export const revokeReplacedTinfoilAuthorization = async (
  db: AnyDrizzleDatabase,
  incoming: ProviderCredentials,
  signal?: AbortSignal,
  auth = tinfoilAuth,
) => {
  const row = await readStoredAuthorization(db)
  if (!row.credentials.access_token || sameAuthorization(row.credentials, incoming)) {
    return
  }
  signal?.throwIfAborted()
  // A failed revoke leaves the previous credentials available for retry.
  await auth.revoke(row.credentials.refresh_token ?? row.credentials.access_token)
  const retired = await db.transaction(async (tx) => {
    const current = await readStoredAuthorization(tx)
    if (!sameAuthorization(current.credentials, row.credentials)) {
      throw new Error('Tinfoil connection changed during revocation')
    }
    if (current.secret) {
      await writeProviderCredentials(
        tx,
        'oauth:tinfoil',
        { ...current.credentials, reauth_required: true },
        current.secret.binding,
      )
    } else if (current.legacy) {
      await saveIntegrationCredentials(
        tx,
        'tinfoil',
        { ...current.legacy.credentials, reauth_required: true },
        current.legacy.enabled,
      )
    }
    // Only our own retirement may advance a legacy fingerprint for the guarded replacement.
    return {
      attempt: await getProviderConnectionAttempt(tx, 'tinfoil'),
      changed: JSON.stringify(current) !== JSON.stringify(row),
    }
  })
  if (retired.changed) {
    throw new Error('Tinfoil connection changed during revocation')
  }
  return retired.attempt
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
  discardAuthorization: (credentials: ProviderCredentials) =>
    deps.lock(async () => {
      const current = await readStoredAuthorization(deps.db())
      if (sameAuthorization(current.credentials, credentials)) {
        return
      }
      const token = credentials.refresh_token ?? credentials.access_token
      if (token) {
        await deps.auth.revoke(token)
      }
    }),
  setEnabled: (enabled: boolean) =>
    deps.lock(() => deps.db().transaction((tx) => setTinfoilSessionEnabledInTransaction(tx, enabled))),
  disconnect: () =>
    deps.lock(async () => {
      const db = deps.db()
      const row = await readStoredAuthorization(db)
      if (row.credentials.access_token) {
        // Keep the connection available for retry if server-side revocation fails.
        await deps.auth.revoke(row.credentials.refresh_token ?? row.credentials.access_token)
      }
      await db.transaction(async (tx) => {
        const current = await readStoredAuthorization(tx)
        const sameSession = row.credentials.access_token
          ? sameAuthorization(current.credentials, row.credentials)
          : JSON.stringify(current) === JSON.stringify(row)
        if (!sameSession) {
          throw new Error('Tinfoil connection changed during revocation')
        }
        const connection = await tx
          .select()
          .from(providerConnectionsTable)
          .where(eq(providerConnectionsTable.id, 'oauth:tinfoil'))
          .get()
        if (connection || row.secret) {
          await writeProviderCredentials(tx, 'oauth:tinfoil', { sessionRevision: crypto.randomUUID() }, null)
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
