/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { createCloudAgentClient } from '@/cloud-agent/client'
import { createCloudOfflineStore } from '@/cloud-agent/offline'
import { useCloudAgentReadiness } from '@/components/cloud-agent/cloud-agent-access'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'

/** Share one account-scoped cloud authorization query between library settings and detail panels. */
export const useCloudConnectionLibrary = () => {
  const auth = useAuth()
  const { data: session } = auth.useSession()
  const ownerId = session && !session.user.isAnonymous ? session.user.id : null
  const http = useHttpClient()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const client = useMemo(
    () => (ownerId ? createCloudAgentClient(http, ownerId, createCloudOfflineStore(db, ownerId)) : null),
    [http, ownerId, db],
  )
  const readiness = useCloudAgentReadiness(ownerId ?? '', !!ownerId)
  const capabilities = useQuery({
    queryKey: ['cloud-agents', ownerId, 'capabilities'],
    queryFn: () => client!.capabilities(),
    enabled: !!client && readiness.data === true,
    retry: false,
    networkMode: 'always',
  })
  const connections = useQuery({
    queryKey: ['cloud-agents', ownerId, 'connections'],
    queryFn: () => client!.connections(),
    enabled: !!client && !!capabilities.data,
    retry: false,
    networkMode: 'always',
  })
  useEffect(() => {
    if (!ownerId) {
      return
    }
    const abort = new AbortController()
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-agents', ownerId, 'connections'] })
      void queryClient.invalidateQueries({ queryKey: ['cloud-agent-encryption', ownerId] })
    }
    window.addEventListener('focus', refresh)
    getPowerSyncInstance()?.onChangeWithCallback(
      { onChange: refresh },
      { tables: ['cloud_agent_projections'], signal: abort.signal },
    )
    return () => {
      abort.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [ownerId, queryClient])
  return {
    ownerId,
    client,
    connections,
    capabilities,
    available: capabilities.data?.enabled === true && !!capabilities.data.runtimeRecipient,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['cloud-agents', ownerId] }),
  }
}
