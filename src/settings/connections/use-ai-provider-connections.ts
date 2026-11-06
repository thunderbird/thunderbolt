/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useChatStore } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getAvailableModels } from '@/dal'
import {
  disconnectProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from '@/dal/provider-connections'

type ConnectionChange =
  | { kind: 'update'; id: string; name?: string; enabled?: boolean }
  | { kind: 'disconnect'; id: string }

/** Owns provider metadata controls independently of model and search preferences. */
export const useAiProviderConnections = () => {
  const { t } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { data: providers = [], isLoading } = useQuery({
    queryKey: ['provider-connections'],
    query: toCompilableQuery(getProviderConnections(db)),
  })
  const mutation = useMutation({
    mutationFn: async (change: ConnectionChange) => {
      if (change.kind === 'update') {
        await updateProviderConnection(db, change.id, { name: change.name, enabled: change.enabled })
      } else {
        await disconnectProviderConnection(db, change.id)
      }
      useChatStore.getState().setModels(await getAvailableModels(db))
      await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
      await queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })
  return {
    providers,
    ready: !isLoading,
    pending: mutation.isPending,
    error: mutation.isError ? t`Could not update the connection. Try again.` : null,
    toggle: (id: string, enabled: boolean) => mutation.mutate({ kind: 'update', id, enabled }),
    rename: (id: string, name: string) => mutation.mutate({ kind: 'update', id, name }),
    disconnect: (id: string) => mutation.mutate({ kind: 'disconnect', id }),
  }
}
