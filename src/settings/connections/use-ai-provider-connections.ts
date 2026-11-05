/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useChatStore } from '@/chats/chat-store'
import { updateModelInTransaction } from '@/dal/models'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useQuery as usePowerSyncQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getAllModels, getAvailableModels } from '@/dal'
import { setTinfoilSessionEnabledInTransaction, withTinfoilSessionLock } from '@/lib/tinfoil-session'
import { getIntegrationCredentials } from '@/dal/integrations'
import { invalidateProviderConnectionAttempts } from '@/lib/provider-connection-attempt'
import { useTinfoilConnection } from '@/hooks/use-tinfoil-connection'
import type { Model } from '@/types'
import type { AiProviderConnection } from './types'

/** Matches the saved models controlled by an account connection, excluding managed and manually added API-key models. */
const belongsToConnection = (
  model: Pick<Model, 'deletedAt' | 'apiKey' | 'oauthProvider' | 'providerDefault'> & {
    provider: Model['provider'] | null
    isSystem: number | null
  },
  provider: AiProviderConnection['id'],
) =>
  model.isSystem !== 1 &&
  !model.deletedAt &&
  model.provider === provider &&
  !model.oauthProvider &&
  model.providerDefault === 1 &&
  Boolean(model.apiKey)

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
  const { data: session, isLoading: sessionLoading } = useTinfoilConnection()
  const toggleMutation = useMutation({
    mutationFn: async (
      change: { provider: AiProviderConnection['id']; enabled: boolean } | { provider: 'otari'; disconnect: true },
    ) => {
      const { provider } = change
      // Session and model access change together under the provider's session lock.
      const updateModels = () =>
        db.transaction(async (tx) => {
          const ownedModels = (await getAllModels(tx)).filter((model) => belongsToConnection(model, provider))
          if (change.provider === 'tinfoil') {
            const current = await getIntegrationCredentials(tx, provider)
            if (
              current?.credentials.access_token &&
              (!change.enabled || !current.credentials.reauth_required || ownedModels.length === 0)
            ) {
              await setTinfoilSessionEnabledInTransaction(tx, change.enabled)
            }
          }
          for (const model of ownedModels) {
            await updateModelInTransaction(
              tx,
              model.id,
              'disconnect' in change ? { apiKey: null } : { enabled: change.enabled ? 1 : 0 },
            )
          }
          await invalidateProviderConnectionAttempts(tx, provider)
        })
      if (provider === 'tinfoil') {
        await withTinfoilSessionLock(updateModels)
      } else {
        await updateModels()
      }
      useChatStore.getState().setModels(await getAvailableModels(db))
      await queryClient.invalidateQueries({ queryKey: ['models'] })
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
        Boolean(session?.enabled) ||
        models.some((model) => belongsToConnection(model, 'tinfoil') && model.enabled === 1),
      connected: Boolean(session?.connected) || models.some((model) => belongsToConnection(model, 'tinfoil')),
      oauthConnected: Boolean(session?.connected),
      needsReauth: Boolean(session?.needsReauth),
    },
    {
      id: 'otari',
      name: t`Otari`,
      enabled: models.some((model) => belongsToConnection(model, 'otari') && model.enabled === 1),
      connected: models.some((model) => belongsToConnection(model, 'otari')),
      needsReauth: false,
    },
  ]
  return {
    providers,
    disconnectOtari: () => toggleMutation.mutate({ provider: 'otari', disconnect: true }),
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
