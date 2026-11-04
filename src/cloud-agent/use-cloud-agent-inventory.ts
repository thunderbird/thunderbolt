/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth, useDatabase, useHttpClient } from '@/contexts'
import { useCloudAgentReadiness } from '@/components/cloud-agent/cloud-agent-access'
import { getPowerSyncInstance } from '@/db/powersync/sync-state'
import { createCloudAgentClient } from './client'
import { createCloudOfflineStore } from './offline'
import { cloudAgentsToInventory } from './agent-inventory'

/** Subscribe the normal composer inventory to owner-scoped cloud projections, without loading connections or outbox contents. */
export const useCloudAgentInventory = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const auth = useAuth()
  const { data: session } = auth.useSession()
  const ownerId = session && !session.user.isAnonymous ? session.user.id : null
  const db = useDatabase()
  const http = useHttpClient()
  const queryClient = useQueryClient()
  const readiness = useCloudAgentReadiness(ownerId ?? '', enabled && !!ownerId)
  const client = useMemo(
    () => (ownerId ? createCloudAgentClient(http, ownerId, createCloudOfflineStore(db, ownerId)) : null),
    [http, db, ownerId],
  )
  const canRead = enabled && !!client && readiness.data === true
  const capabilities = useQuery({
    queryKey: ['cloud-agents', ownerId, 'capabilities'],
    queryFn: () => client!.capabilities(),
    enabled: canRead,
    retry: false,
    networkMode: 'always',
  })
  const agents = useQuery({
    queryKey: ['cloud-agents', ownerId, 'agents'],
    queryFn: () => client!.agents(),
    enabled: canRead && capabilities.data?.enabled === true,
    retry: false,
    networkMode: 'always',
  })
  useEffect(() => {
    if (!enabled || !ownerId) {
      return
    }
    const abort = new AbortController()
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-agents', ownerId, 'agents'] })
      void queryClient.invalidateQueries({ queryKey: ['cloud-agents', ownerId, 'capabilities'] })
      void queryClient.invalidateQueries({ queryKey: ['cloud-agent-encryption', ownerId] })
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    getPowerSyncInstance()?.onChangeWithCallback(
      { onChange: refresh },
      { tables: ['cloud_agent_projections'], signal: abort.signal },
    )
    return () => {
      abort.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [enabled, ownerId, queryClient])
  return {
    client,
    ownerId,
    enabled: canRead && capabilities.data?.enabled === true,
    views:
      canRead && ownerId
        ? (agents.data ?? []).filter(({ record }) => record.ownerId === ownerId && !record.deletedAt)
        : [],
    agents:
      canRead && ownerId ? cloudAgentsToInventory(agents.data ?? [], ownerId, capabilities.data?.enabled === true) : [],
    isLoading: canRead && (capabilities.isLoading || agents.isLoading),
    error: readiness.error ?? capabilities.error ?? agents.error,
  }
}
