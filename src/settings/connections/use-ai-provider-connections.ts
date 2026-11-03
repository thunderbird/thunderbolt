/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useChatStore } from '@/chats/chat-store'
import { updateModelInTransaction } from '@/dal/models'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { useQuery as usePowerSyncQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getAllModels, getAvailableModels } from '@/dal'
import { tinfoilSession } from '@/lib/tinfoil-session'
import { getIntegrationCredentials } from '@/dal/integrations'
import type { Model } from '@/types'
import type { AiProviderConnection } from './types'

/** Matches the saved models controlled by an account connection, excluding managed and BYOK Tinfoil models. */
const belongsToConnection = (model: Model, provider: AiProviderConnection['id']) =>
  model.isSystem !== 1 &&
  !model.deletedAt &&
  (provider === 'tinfoil'
    ? model.oauthProvider === 'tinfoil'
    : model.provider === 'openrouter' && Boolean(model.apiKey))

/** Reads device-local provider access independently of individual model toggles. */
export const useAiProviderConnections = () => {
  const { t } = useLingui()
  const [confirmDisable, setConfirmDisable] = useState(false)
  const queryClient = useQueryClient()
  const db = useDatabase()
  const { data: models = [], isLoading: modelsLoading } = usePowerSyncQuery({
    queryKey: ['models', 'provider-connections'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const { data: session, isLoading: sessionLoading } = useQuery({
    queryKey: ['tinfoil-session'],
    queryFn: () => getIntegrationCredentials(db, 'tinfoil'),
  })
  const toggleMutation = useMutation({
    mutationFn: async ({ provider, enabled }: { provider: AiProviderConnection['id']; enabled: boolean }) => {
      if (provider === 'tinfoil') {
        await tinfoilSession.setEnabled(enabled)
      } else {
        // Re-read so toggling includes models added since the last render.
        await db.transaction(async (tx) => {
          for (const model of await getAllModels(tx)) {
            if (belongsToConnection(model, provider)) {
              await updateModelInTransaction(tx, model.id, { enabled: enabled ? 1 : 0 })
            }
          }
        })
      }
      useChatStore.getState().setModels(await getAvailableModels(db))
      await queryClient.invalidateQueries({ queryKey: ['models'] })
      await queryClient.invalidateQueries({ queryKey: ['tinfoil-session'] })
    },
  })
  const providers: AiProviderConnection[] = [
    {
      id: 'openrouter',
      name: t`OpenRouter`,
      enabled: models.some((model) => belongsToConnection(model, 'openrouter') && model.enabled === 1),
      needsReauth: false,
      connected: models.some((model) => belongsToConnection(model, 'openrouter')),
    },
    {
      id: 'tinfoil',
      name: t`Tinfoil`,
      enabled:
        Boolean(session?.enabled) &&
        models.some((model) => belongsToConnection(model, 'tinfoil') && model.enabled === 1),
      connected: Boolean(session?.credentials.access_token),
      needsReauth: Boolean(session?.credentials.reauth_required),
    },
  ]
  return {
    providers,
    ready: !modelsLoading && !sessionLoading,
    confirmDisable,
    cancelDisable: () => {
      if (toggleMutation.isPending) {
        return
      }
      setConfirmDisable(false)
      toggleMutation.reset()
    },
    disableConfirmed: () =>
      toggleMutation.mutate(
        { provider: 'tinfoil', enabled: false },
        {
          onSuccess: () => setConfirmDisable(false),
        },
      ),
    toggle: (provider: AiProviderConnection['id'], enabled: boolean) => {
      if (provider === 'tinfoil' && !enabled) {
        toggleMutation.reset()
        setConfirmDisable(true)
        return
      }
      toggleMutation.mutate({ provider, enabled })
    },
    pending: toggleMutation.isPending,
    error: toggleMutation.isError ? t`Could not update the provider connection. Try again.` : null,
  }
}
