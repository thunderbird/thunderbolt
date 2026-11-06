/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useDatabase } from '@/contexts'
import { getProviderConnection, saveProviderConnection } from '@/dal/provider-connections'
import { getAvailableModels } from '@/dal/models'
import { useChatStore } from '@/chats/chat-store'
import { loadOtariSearchStatus } from '@/integrations/otari-search/capabilities'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderAuthMethod, ProviderConnection, ProviderType } from '@/providers/types'
import type { useProviderAuthorization } from '@/providers/use-provider-authorization'

type FormState = { name: string; authMethod: ProviderAuthMethod; url: string; apiKey: string; customUrl: boolean }
type FormAction = { [Key in keyof FormState]: { field: Key; value: FormState[Key] } }[keyof FormState]

/** Keeps new credentials only in the form until the connection DAL stores them locally. */
export const useProviderConnectionForm = ({
  provider,
  connection,
  authorization,
  onSaved,
}: {
  provider: ProviderType
  connection?: ProviderConnection
  authorization: ReturnType<typeof useProviderAuthorization>
  onSaved: (id: string) => void
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const definition = getProviderDefinition(provider)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const [state, dispatch] = useReducer(
    (state: FormState, action: FormAction): FormState => ({ ...state, [action.field]: action.value }),
    {
      name: connection?.name ?? definition.name,
      authMethod: connection?.authMethod ?? (definition.oauth ? 'oauth' : 'api_key'),
      url: connection?.url ?? definition.defaultUrl ?? '',
      apiKey: '',
      customUrl: Boolean(connection?.url && connection.url !== definition.defaultUrl),
    },
  )
  const mutation = useMutation({
    mutationFn: async () => {
      const controller = new AbortController()
      pending.current = controller
      const id = await saveProviderConnection(db, {
        id: connection?.id,
        provider,
        name: state.name.trim(),
        authMethod: 'api_key',
        url: definition.requiresUrl ? state.url.trim() : null,
        credentials: { apiKey: state.apiKey.trim() },
        enabled: connection ? connection.enabled === 1 : true,
        signal: controller.signal,
      })
      return { id, controller }
    },
    onSuccess: async ({ id, controller }) => {
      controller.signal.throwIfAborted()
      if (provider === 'tinfoil') {
        useSearchProviderStore.getState().configureProviderSearch(id, 'available', { select: false })
      }
      if (provider === 'otari') {
        const connection = await getProviderConnection(db, id)
        const status = await loadOtariSearchStatus(
          connection!.url!,
          state.apiKey.trim(),
          AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        )
        controller.signal.throwIfAborted()
        useSearchProviderStore.getState().configureProviderSearch(id, status, { select: false })
      }
      useChatStore.getState().setModels(await getAvailableModels(db))
      await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
      await queryClient.invalidateQueries({ queryKey: ['models'] })
      controller.signal.throwIfAborted()
      onSaved(id)
    },
  })
  const busy = mutation.isPending || authorization.isPending
  const valid =
    Boolean(state.name.trim()) &&
    (!definition.requiresUrl || Boolean(state.url.trim())) &&
    (state.authMethod === 'oauth' || provider === 'custom' || Boolean(state.apiKey.trim()))
  const submit = () => {
    if (!valid || busy) {
      return
    }
    if (state.authMethod === 'oauth' && (provider === 'otari' || provider === 'tinfoil' || provider === 'openrouter')) {
      void authorization.authorize({ provider, name: state.name.trim(), url: state.url, id: connection?.id })
      return
    }
    mutation.mutate()
  }
  return {
    ...state,
    definition,
    busy,
    valid,
    dispatch,
    submit,
    error: mutation.isError ? t`Could not save the connection. Try again.` : authorization.error,
  }
}
