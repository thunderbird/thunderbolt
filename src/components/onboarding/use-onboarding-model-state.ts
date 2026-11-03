/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateModelInTransaction } from '@/dal/models'
import { tinfoilSession } from '@/lib/tinfoil-session'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { getAllModels, getAvailableModels } from '@/dal'
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
  const queryClient = useQueryClient()
  const { data: models = [], isLoading } = useQuery({
    queryKey: ['models', 'onboarding'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const configuredModels = models.filter(isConfiguredStandaloneModel)
  const disconnectProvider = async (provider: OnboardingProvider, oauthOnly = false) => {
    if (provider === 'tinfoil') {
      await tinfoilSession.disconnect()
    }
    // Keep model identities and chat history while removing device-local access.
    await db.transaction(async (tx) => {
      for (const model of (await getAllModels(tx)).filter(
        (model) =>
          model.provider === provider && model.isSystem !== 1 && !model.deletedAt && !model.oauthProvider && !oauthOnly,
      )) {
        await updateModelInTransaction(tx, model.id, { apiKey: null, enabled: 0 })
      }
    })
    useChatStore.getState().setModels(await getAvailableModels(db))
    await queryClient.invalidateQueries({ queryKey: ['models'] })
    await queryClient.invalidateQueries({ queryKey: ['tinfoil-session'] })
  }
  return { configuredModels, hasConfiguredModel: configuredModels.length > 0, isLoading, disconnectProvider }
}
