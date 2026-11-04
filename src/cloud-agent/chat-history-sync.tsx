/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useEffectEvent, useMemo } from 'react'
import { useDatabase } from '@/contexts'
import { useCloudAgentInventory } from './use-cloud-agent-inventory'
import { createCloudChatHistoryImporter } from './chat-history'

/** Bring scheduled and existing durable conversations into the ordinary sidebar on every app route. */
const CloudChatHistorySync = () => {
  const db = useDatabase()
  const inventory = useCloudAgentInventory()
  const importer = useMemo(
    () => (inventory.client ? createCloudChatHistoryImporter(db, inventory.client) : null),
    [db, inventory.client],
  )
  const synchronize = useEffectEvent(async (signal: AbortSignal) => {
    if (inventory.enabled && importer) {
      await importer(inventory.views, signal)
    }
  })
  useEffect(() => {
    if (!inventory.enabled || !importer) {
      return
    }
    const abort = new AbortController()
    const state = { running: false }
    const synchronizeOnce = async () => {
      if (state.running || abort.signal.aborted || !navigator.onLine) {
        return
      }
      state.running = true
      try {
        await synchronize(abort.signal)
      } finally {
        state.running = false
      }
    }
    const wake = () => {
      void synchronizeOnce().catch(() => {
        if (!abort.signal.aborted) {
          console.error('Cloud chat history refresh failed; it will retry on the next refresh.')
        }
      })
    }
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    const timer = window.setInterval(wake, 15000)
    wake()
    return () => {
      abort.abort()
      window.clearInterval(timer)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
    }
  }, [importer, inventory.enabled])
  return null
}
export default CloudChatHistorySync
