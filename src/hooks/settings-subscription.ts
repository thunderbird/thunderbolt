/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CommonPowerSyncDatabase } from '@powersync/common'
import type { QueryClient } from '@tanstack/react-query'

type SettingsDatabase = Pick<CommonPowerSyncDatabase, 'onChangeWithCallback' | 'registerListener'>
type Subscription = { subscribers: number; dispose: () => void }

const subscriptions = new WeakMap<SettingsDatabase, WeakMap<QueryClient, Subscription>>()

/** Watch settings rows and schema replacements until the final consumer leaves. */
const createSubscription = (database: SettingsDatabase, client: QueryClient): Subscription => {
  const abort = new AbortController()
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['settings'] })
  }
  database.onChangeWithCallback({ onChange: invalidate }, { tables: ['settings'], signal: abort.signal })
  const stopSchema = database.registerListener({ schemaChanged: invalidate })
  return {
    subscribers: 0,
    dispose: () => {
      // Aborting also cancels PowerSync's queued, throttled change callbacks.
      abort.abort()
      stopSchema()
    },
  }
}

/**
 * Share one settings-table watcher per database/query cache. The table is known,
 * so each settings consumer needn't EXPLAIN its query to discover dependencies.
 * Keep each consumer's existing query key and result so unrelated settings don't
 * cause its result to change. Release the watcher when the final consumer leaves.
 */
export const subscribeToSettingsChanges = (database: SettingsDatabase, client: QueryClient): (() => void) => {
  const clients = subscriptions.get(database) ?? new WeakMap<QueryClient, Subscription>()
  subscriptions.set(database, clients)
  const subscription = clients.get(client) ?? createSubscription(database, client)
  clients.set(client, subscription)
  subscription.subscribers += 1

  return () => {
    subscription.subscribers -= 1
    if (subscription.subscribers !== 0) {
      return
    }
    subscription.dispose()
    clients.delete(client)
  }
}
