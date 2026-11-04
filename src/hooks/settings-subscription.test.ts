/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { QueryClient } from '@tanstack/react-query'
import { Schema } from '@powersync/common'
import { expect, it, mock } from 'bun:test'
import { subscribeToSettingsChanges } from './settings-subscription'

type SettingsDatabase = Parameters<typeof subscribeToSettingsChanges>[0]

/** Capture actual watcher callbacks without replacing any shared modules. */
const createDatabase = () => {
  const stopChanges = mock(() => {})
  const stopSchema = mock(() => {})
  const database: SettingsDatabase = {
    onChangeWithCallback: mock((_handler, options) => {
      options?.signal?.addEventListener('abort', stopChanges)
      return stopChanges
    }),
    registerListener: mock(() => stopSchema),
  }
  return { database, stopChanges, stopSchema }
}

it('keeps the shared watcher alive until the final settings consumer leaves', () => {
  const { database, stopChanges, stopSchema } = createDatabase()
  const client = new QueryClient()
  const first = subscribeToSettingsChanges(database, client)
  const second = subscribeToSettingsChanges(database, client)
  expect(database.onChangeWithCallback).toHaveBeenCalledTimes(1)
  first()
  expect(stopChanges).not.toHaveBeenCalled()
  second()
  expect(stopChanges).toHaveBeenCalledTimes(1)
  expect(stopSchema).toHaveBeenCalledTimes(1)

  const remount = subscribeToSettingsChanges(database, client)
  expect(database.onChangeWithCallback).toHaveBeenCalledTimes(2)
  remount()
})

it('invalidates every settings key, including on schema replacement, without touching other data', async () => {
  const client = new QueryClient()
  const callbacks: { changed?: () => void; schemaChanged?: () => void } = {}
  const database: SettingsDatabase = {
    onChangeWithCallback: (handler) => {
      callbacks.changed = () => {
        void handler?.onChange({ changedTables: ['settings'] })
      }
      return () => {}
    },
    registerListener: (listener) => {
      callbacks.schemaChanged = () => {
        void listener.schemaChanged?.(new Schema({}))
      }
      return () => {}
    },
  }
  const stop = subscribeToSettingsChanges(database, client)
  for (const notify of [callbacks.changed, callbacks.schemaChanged]) {
    client.setQueryData(['settings', 'language'], [])
    client.setQueryData(['settings', 'sidebar_state'], [])
    client.setQueryData(['models'], [])
    notify?.()
    expect(client.getQueryState(['settings', 'language'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['settings', 'sidebar_state'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['models'])?.isInvalidated).toBe(false)
  }
  stop()
  client.clear()
})

it('isolates subscriptions by database and query client', () => {
  const firstDb = createDatabase()
  const secondDb = createDatabase()
  const firstClient = new QueryClient()
  const secondClient = new QueryClient()
  const stops = [
    subscribeToSettingsChanges(firstDb.database, firstClient),
    subscribeToSettingsChanges(firstDb.database, secondClient),
    subscribeToSettingsChanges(secondDb.database, firstClient),
  ]
  expect(firstDb.database.onChangeWithCallback).toHaveBeenCalledTimes(2)
  expect(secondDb.database.onChangeWithCallback).toHaveBeenCalledTimes(1)
  stops.forEach((stop) => stop())
})
