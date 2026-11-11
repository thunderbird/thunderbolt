/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProviderVisibility } from '@/providers/use-provider-visibility'
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useChatStore } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getAvailableModels } from '@/dal'
import {
  disconnectProviderConnection,
  deleteProviderConnection,
  getProviderConnections,
  getModelProviderConnectionIds,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { useSearchProviderStore } from '@/stores/search-provider-store'

type ConnectionChange = { kind: 'update'; id: string; enabled: boolean } | { kind: 'disconnect' | 'remove'; id: string }

/** Owns provider metadata controls independently of model and search preferences. */
export const useAiProviderConnections = () => {
  const { t } = useLingui()
  const db = useDatabase()
  const { isProviderVisible } = useProviderVisibility()
  const queryClient = useQueryClient()
  const { data: allProviders = [], isSuccess: providersReady } = useQuery({
    queryKey: ['provider-connections'],
    query: toCompilableQuery(getProviderConnections(db)),
  })
  const providers = allProviders.filter((connection) => isProviderVisible(connection.provider))
  const { data: modelConnections = [], isSuccess: modelsReady } = useQuery({
    queryKey: ['model-provider-connections'],
    query: toCompilableQuery(getModelProviderConnectionIds(db)),
  })
  const searchConnectionId = useSearchProviderStore((state) =>
    state.selection === 'connection' ? state.connectionId : null,
  )
  const [disableId, setDisableId] = useState<string | null>(null)
  const ready = providersReady && modelsReady
  const mutation = useMutation({
    mutationFn: async (change: ConnectionChange) => {
      if (change.kind === 'update') {
        await updateProviderConnection(db, change.id, { enabled: change.enabled })
      } else if (change.kind === 'remove') {
        await deleteProviderConnection(db, change.id)
      } else {
        await disconnectProviderConnection(db, change.id)
      }
      const [models] = await Promise.all([
        getAvailableModels(db),
        queryClient.invalidateQueries({ queryKey: ['provider-connections'] }),
        queryClient.invalidateQueries({ queryKey: ['chatgpt-accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
      ])
      useChatStore.getState().setModels(models)
    },
  })
  const pendingChange = mutation.isPending ? mutation.variables : undefined
  const visibleProviders = providers.map((provider) =>
    pendingChange?.kind === 'update' && pendingChange.enabled !== undefined && pendingChange.id === provider.id
      ? { ...provider, enabled: pendingChange.enabled ? 1 : 0 }
      : provider,
  )
  return {
    providers: visibleProviders,
    ready,
    pending: mutation.isPending,
    error: mutation.isError ? t`Could not update the connection. Try again.` : null,
    toggle: (id: string, enabled: boolean) => {
      if (!ready || mutation.isPending) {
        return
      }
      if (!enabled && (searchConnectionId === id || modelConnections.some(({ connectionId }) => connectionId === id))) {
        setDisableId(id)
        return
      }
      mutation.mutate({ kind: 'update', id, enabled })
    },
    pendingDisable: providers.find((provider) => provider.id === disableId),
    cancelDisable: () => setDisableId(null),
    confirmDisable: () => {
      if (!disableId || mutation.isPending) {
        return
      }
      mutation.mutate({ kind: 'update', id: disableId, enabled: false })
      setDisableId(null)
    },
    remove: (id: string, onSuccess: () => void) => mutation.mutate({ kind: 'remove', id }, { onSuccess }),
    disconnect: (id: string) => mutation.mutate({ kind: 'disconnect', id }),
  }
}
