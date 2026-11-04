/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDatabase, useHttpClient } from '@/contexts'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { createCloudAgentClient } from '@/cloud-agent/client'
import { createCloudOfflineStore } from '@/cloud-agent/offline'

const subscribeOnline = (changed: () => void) => {
  window.addEventListener('online', changed)
  window.addEventListener('offline', changed)
  return () => {
    window.removeEventListener('online', changed)
    window.removeEventListener('offline', changed)
  }
}
const onlineSnapshot = () => navigator.onLine

/** Keep encrypted persistent state and decrypted query results scoped to the signed-in owner. */
export const useCloudAgentsState = (
  ownerId: string,
  { enabled = true, contentEnabled = enabled }: { enabled?: boolean; contentEnabled?: boolean } = {},
) => {
  const http = useHttpClient()
  const db = useDatabase()
  const client = useMemo(
    () => createCloudAgentClient(http, ownerId, createCloudOfflineStore(db, ownerId)),
    [http, ownerId, db],
  )
  const queryClient = useQueryClient()
  const online = useSyncExternalStore(subscribeOnline, onlineSnapshot, () => true)
  const queryKey = ['cloud-agents', ownerId]
  const capabilities = useQuery({
    queryKey: [...queryKey, 'capabilities'],
    queryFn: client.capabilities,
    retry: false,
    networkMode: 'always',
    enabled,
  })
  const canReadContent = enabled && contentEnabled && capabilities.data?.enabled === true
  const agents = useQuery({
    queryKey: [...queryKey, 'agents'],
    queryFn: client.agents,
    enabled: canReadContent,
    retry: false,
    networkMode: 'always',
  })
  const connections = useQuery({
    queryKey: [...queryKey, 'connections'],
    queryFn: client.connections,
    enabled: canReadContent,
    retry: false,
    networkMode: 'always',
  })
  const outbox = useQuery({
    queryKey: [...queryKey, 'outbox'],
    queryFn: client.outbox,
    networkMode: 'always',
    enabled: enabled && contentEnabled,
  })

  // Observe replicated state and local command acknowledgements from SQLite.
  useEffect(() => {
    const abort = new AbortController()
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-agents', ownerId] })
    }
    window.addEventListener('focus', refresh)
    getPowerSyncInstance()?.onChangeWithCallback(
      { onChange: refresh },
      { tables: ['cloud_agent_projections', 'cloud_agent_outbox'], signal: abort.signal },
    )
    return () => {
      window.removeEventListener('focus', refresh)
      abort.abort()
    }
  }, [client, ownerId, queryClient])

  return {
    client,
    queryKey,
    capabilities,
    agents,
    connections,
    outbox,
    online,
    refresh: () => queryClient.invalidateQueries({ queryKey }),
  }
}
