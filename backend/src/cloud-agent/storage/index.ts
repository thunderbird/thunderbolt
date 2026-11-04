/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Storage } from '@earendil-works/pi-durable'
import { RuntimeOwner, type RuntimeStoreOptions } from './owner'
import { PostgresNamespaceStorage } from './storage'
import type { StorageCodec } from './types'

export type { StorageCodec } from './types'
export type { RuntimeStoreOptions } from './owner'

export type PostgresRuntimeStore = {
  openNamespace: (namespace: string, codec: StorageCodec) => Promise<Storage>
  close: () => Promise<void>
}

/** Open the sole runtime owner; independent namespaces share its FIFO connection without sharing state or keys. */
export const openPostgresRuntimeStore = async (options: RuntimeStoreOptions): Promise<PostgresRuntimeStore> => {
  const owner = new RuntimeOwner(options)
  try {
    await owner.open()
  } catch (error) {
    await owner.close()
    throw error
  }
  const namespaces = new Set<string>()
  return {
    openNamespace: async (namespace, codec) => {
      if (!namespace) {
        throw new Error('A cloud runtime namespace is required')
      }
      if (namespaces.has(namespace)) {
        throw new Error('Cloud runtime namespace is already open')
      }
      namespaces.add(namespace)
      const storage = new PostgresNamespaceStorage(owner, namespace, codec, () => {
        namespaces.delete(namespace)
      })
      try {
        await storage.initialize()
        return storage
      } catch (error) {
        namespaces.delete(namespace)
        throw error
      }
    },
    close: () => owner.close(),
  }
}
