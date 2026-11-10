/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { localSavedPageKeyPrefix, parseSavedPage, type SavedPage } from './saved-page'

type PageStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>

/** Local launch shortcuts never enter PowerSync, exports, or another device's URL space. */
export const createLocalSavedPagesStore = (getStorage: () => PageStorage = () => localStorage) => {
  const listeners = new Set<() => void>()
  let serialized = ''
  let snapshot: readonly SavedPage[] = []
  const getSnapshot = (): readonly SavedPage[] => {
    const storage = getStorage()
    const entries = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(localSavedPageKeyPrefix))
      .sort()
      .map((key) => [key, storage.getItem(key)] as const)
    const next = JSON.stringify(entries)
    if (next !== serialized) {
      serialized = next
      snapshot = entries.flatMap(([key, value]) => {
        const page = parseSavedPage(value)
        return page && page.source.kind === 'local-app' && key === `${localSavedPageKeyPrefix}${page.id}` ? [page] : []
      })
    }
    return snapshot
  }
  const notify = () => listeners.forEach((listener) => listener())
  const onStorage = (event: StorageEvent) => {
    if ((event.key === null || event.key.startsWith(localSavedPageKeyPrefix)) && event.storageArea === getStorage()) {
      notify()
    }
  }
  return {
    getSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (listeners.size === 1 && typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && typeof window !== 'undefined') {
          window.removeEventListener('storage', onStorage)
        }
      }
    },
    save: (page: SavedPage) => {
      const parsed = parseSavedPage(page)
      if (!parsed || parsed.source.kind !== 'local-app') {
        throw new Error('Only local app pages belong in device-local storage')
      }
      getStorage().setItem(`${localSavedPageKeyPrefix}${parsed.id}`, JSON.stringify(parsed))
      notify()
    },
    /** Re-read after identity cleanup clears web storage in this same window. */
    refresh: notify,
  }
}

export const localSavedPagesStore = createLocalSavedPagesStore()
