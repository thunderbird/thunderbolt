/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useReducer, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDatabase, useHttpClient } from '@/contexts'
import { needsSyncSetupWizard } from '@/db/encryption'
import { getPrimaryKeyId } from '@/crypto/key-storage'
import { getPowerSyncInstance, setSyncEnabled, syncEnabledChangeEvent } from '@/db/powersync/sync-state'
import { createArtifactClient } from '@/artifacts/client'
import { useMessageArtifacts } from '@/artifacts/use-message-artifacts'

const subscribeOnline = (changed: () => void) => {
  window.addEventListener('online', changed)
  window.addEventListener('offline', changed)
  return () => {
    window.removeEventListener('online', changed)
    window.removeEventListener('offline', changed)
  }
}
const onlineSnapshot = () => navigator.onLine

/** Join local artifacts with owner-scoped encrypted snapshots without requiring an agent or runtime. */
export const useArtifactsState = (ownerId: string | null) => {
  const db = useDatabase()
  const http = useHttpClient()
  const queryClient = useQueryClient()
  const local = useMessageArtifacts()
  const online = useSyncExternalStore(subscribeOnline, onlineSnapshot, () => true)
  const [view, patch] = useReducer(
    (current: { search: string; setupOpen: boolean }, next: Partial<typeof current>) => ({ ...current, ...next }),
    { search: '', setupOpen: false },
  )
  const client = useMemo(() => (ownerId ? createArtifactClient(http, ownerId, db) : null), [http, ownerId, db])
  const ready = useQuery({
    queryKey: ['artifact-encryption', ownerId],
    queryFn: async () => !(await needsSyncSetupWizard()) && !!(await getPrimaryKeyId()),
    enabled: !!ownerId,
    networkMode: 'always',
    retry: false,
  })
  const snapshots = useQuery({
    queryKey: ['artifacts', ownerId, 'list'],
    queryFn: async () => Promise.all((await client!.artifacts()).map((artifact) => client!.getArtifact(artifact.id))),
    enabled: !!client && ready.data === true,
    networkMode: 'always',
    retry: false,
  })
  const completeSetup = useMutation({
    mutationFn: async () => {
      await setSyncEnabled(true)
      await queryClient.invalidateQueries({ queryKey: ['artifact-encryption', ownerId] })
      patch({ setupOpen: false })
    },
    networkMode: 'always',
  })
  useEffect(() => {
    const abort = new AbortController()
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['artifacts', ownerId] })
      void queryClient.invalidateQueries({ queryKey: ['artifact-encryption', ownerId] })
    }
    window.addEventListener('focus', refresh)
    window.addEventListener(syncEnabledChangeEvent, refresh)
    getPowerSyncInstance()?.onChangeWithCallback(
      { onChange: refresh },
      { tables: ['cloud_agent_projections'], signal: abort.signal },
    )
    return () => {
      abort.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener(syncEnabledChangeEvent, refresh)
    }
  }, [ownerId, queryClient])
  return {
    client,
    local,
    snapshots,
    ready,
    view,
    patch,
    completeSetup,
    online,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['artifacts', ownerId] }),
  }
}
