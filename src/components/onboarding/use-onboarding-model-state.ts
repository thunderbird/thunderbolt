/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProviderVisibility } from '@/providers/use-provider-visibility'
import { getProviderConnections, disconnectProviderConnection } from '@/dal/provider-connections'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { getAllModels, getAvailableModels, getSettings } from '@/dal'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/chats/chat-store'
import type { OnboardingProvider } from './provider-default-model'
import { isStandaloneModelReady } from '@/settings/models/model-policy'
import type { Model } from '@/types'

/** Only configured, enabled user models can satisfy standalone onboarding. */
export const isConfiguredStandaloneModel = (model: Model): boolean =>
  isStandaloneModelReady(model) && model.isSystem !== 1 && !model.deletedAt && Boolean(model.model.trim())

/** Reads the same persisted models used by Settings and the chat picker. */
export const useOnboardingModelState = () => {
  const db = useDatabase()
  const { isProviderVisible } = useProviderVisibility()
  const queryClient = useQueryClient()
  const { data: models = [], isLoading: modelsLoading } = useQuery({
    queryKey: ['models', 'onboarding'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const connectedModels = models.filter(
    (model) => isProviderVisible(model.provider) && isConfiguredStandaloneModel({ ...model, enabled: 1 }),
  )
  const configuredModels = connectedModels.filter((model) => model.enabled === 1)
  const connectedProviders = connectedModels.map(({ provider }): OnboardingProvider | 'otari' | 'custom' =>
    provider === 'openrouter' || provider === 'tinfoil' || provider === 'otari' ? provider : 'custom',
  )
  const disconnectProvider = async (provider: OnboardingProvider) => {
    const connections = (await getProviderConnections(db)).filter(
      (connection) => connection.provider === provider && connection.connected,
    )
    const currentModels = ((await getAllModels(db)) as Model[]).filter(
      (model) => model.provider === provider && isConfiguredStandaloneModel({ ...model, enabled: 1 }),
    )
    const { selectedModel } = await getSettings(db, { selected_model: '' })
    const selected = currentModels.find((model) => model.id === selectedModel) ?? currentModels[0]
    const connection =
      connections.find((connection) => connection.authMethod === 'oauth') ??
      connections.find((connection) => connection.id === selected?.providerConnectionId)
    if (connection) {
      await disconnectProviderConnection(db, connection.id)
    }
    useChatStore.getState().setModels(await getAvailableModels(db))
    await queryClient.invalidateQueries({ queryKey: ['models'] })
    await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
  }
  return {
    connectedModels,
    connectedProviders,
    configuredModels,
    hasConfiguredModel: configuredModels.length > 0,
    isLoading: modelsLoading,
    disconnectProvider,
  }
}
