/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { createCloudAgentClient } from './client'
import { createCloudOfflineStore } from './offline'
import CloudChatHistorySync from './chat-history-sync'

const OwnerCloudAgentSync = ({ ownerId }: { ownerId: string }) => {
  const db = useDatabase()
  const http = useHttpClient()
  const queryClient = useQueryClient()
  const client = useMemo(
    () => createCloudAgentClient(http, ownerId, createCloudOfflineStore(db, ownerId)),
    [http, ownerId, db],
  )
  useEffect(() => {
    const abort = new AbortController()
    const state = { flushing: false }
    const flush = async () => {
      if (state.flushing || !navigator.onLine || abort.signal.aborted) {
        return
      }
      state.flushing = true
      try {
        const pending = await client.outbox()
        if (!pending.some((entry) => entry.status === 'pending')) {
          return
        }
        await client.flushOutbox(abort.signal)
        if (!abort.signal.aborted) {
          await queryClient.invalidateQueries({ queryKey: ['cloud-agents', ownerId] })
        }
      } finally {
        state.flushing = false
      }
    }
    const wake = () => {
      void flush().catch((error: unknown) => console.error('Cloud outbox sync failed', error))
    }
    getPowerSyncInstance()?.onChangeWithCallback(
      { onChange: wake },
      { tables: ['cloud_agent_outbox'], signal: abort.signal },
    )
    window.addEventListener('online', wake)
    const timer = window.setInterval(wake, 15000)
    wake()
    return () => {
      abort.abort()
      window.removeEventListener('online', wake)
      window.clearInterval(timer)
    }
  }, [client, ownerId, queryClient])
  return <CloudChatHistorySync />
}

/** Resume only commands already authorized and saved by this owner, on any app route. */
const CloudAgentSync = () => {
  const auth = useAuth()
  const { data: session } = auth.useSession()
  return session?.user.id && !session.user.isAnonymous ? (
    <OwnerCloudAgentSync key={session.user.id} ownerId={session.user.id} />
  ) : null
}
export default CloudAgentSync
