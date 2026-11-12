/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useDatabase } from '@/contexts'
import {
  getProviderConnectionRevision,
  resolveProviderConnection,
  saveProviderConnectionWithRevision,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { getAvailableModels } from '@/dal/models'
import { createIdentityController } from '@/lib/identity-lifetime'
import { canConnectChatGPT } from '@/providers/chatgpt-auth'
import { useChatStore } from '@/chats/chat-store'
import { loadOtariSearchStatus } from '@/integrations/otari-search/capabilities'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { getProviderDefinition } from '@/providers/registry'
import {
  ProviderConnectionValidationError,
  validateProviderConnectionCredentials,
} from '@/providers/connection-validation'
import type { ProviderAuthMethod, ProviderConnection, ProviderType, OAuthProviderType } from '@/providers/types'
import type { useProviderAuthorization } from '@/providers/use-provider-authorization'

type FormState = { name: string; authMethod: ProviderAuthMethod; url: string; apiKey: string; customUrl: boolean }
type FormAction = { [Key in keyof FormState]: { field: Key; value: FormState[Key] } }[keyof FormState]

/** Keeps new credentials only in the form until the connection DAL stores them locally. */
export const useProviderConnectionForm = ({
  provider,
  connection,
  existingOAuth,
  authorization,
  onSaved,
  mode = 'connect',
  initialAuthMethod,
}: {
  provider: ProviderType
  connection?: ProviderConnection
  existingOAuth?: ProviderConnection
  authorization: Omit<ReturnType<typeof useProviderAuthorization>, 'processMcpCallback'>
  onSaved: (id: string) => void
  mode?: 'connect' | 'edit'
  initialAuthMethod?: ProviderAuthMethod
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const definition = getProviderDefinition(provider)
  const pending = useRef<ReturnType<typeof createIdentityController> | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const [state, dispatch] = useReducer(
    (state: FormState, action: FormAction): FormState => ({ ...state, [action.field]: action.value }),
    {
      name: connection?.name ?? definition.name,
      authMethod:
        connection?.authMethod ??
        initialAuthMethod ??
        (definition.oauth && (provider !== 'openai' || canConnectChatGPT()) ? 'oauth' : 'api_key'),
      url: connection?.url ?? definition.defaultUrl ?? '',
      apiKey: '',
      customUrl: Boolean(connection?.url && connection.url !== definition.defaultUrl),
    },
  )
  const editing = mode === 'edit'
  const oauthLocked = editing && connection?.authMethod === 'oauth'
  const urlChanged = state.url.trim() !== (connection?.url ?? definition.defaultUrl ?? '')
  const credentialsChanged = !editing || (!oauthLocked && (Boolean(state.apiKey.trim()) || urlChanged))
  const mutation = useMutation({
    mutationFn: async (controller: ReturnType<typeof createIdentityController>) => {
      if (editing && !credentialsChanged) {
        controller.signal.throwIfAborted()
        await updateProviderConnection(db, connection!.id, { name: state.name.trim() })
        return {
          id: connection!.id,
          revision: (await getProviderConnectionRevision(db, connection!.id))!,
          controller,
          credentialsChanged: false,
        }
      }
      const expectedRevision = connection ? await getProviderConnectionRevision(db, connection.id) : undefined
      await validateProviderConnectionCredentials({ provider, apiKey: state.apiKey.trim(), signal: controller.signal })
      controller.signal.throwIfAborted()
      const saved = await saveProviderConnectionWithRevision(db, {
        id: connection?.id,
        expectedRevision,
        provider,
        name: state.name.trim(),
        authMethod: 'api_key',
        url: definition.requiresUrl ? state.url.trim() : null,
        credentials: { apiKey: state.apiKey.trim() },
        enabled: connection ? connection.enabled === 1 : true,
        signal: controller.signal,
      })
      return { ...saved, controller, credentialsChanged: true }
    },
    onSuccess: async ({ id, revision, controller, credentialsChanged }) => {
      const assertCurrent = async () => {
        const current = await getProviderConnectionRevision(db, id)
        controller.signal.throwIfAborted()
        if (current !== revision) {
          throw new Error('Provider connection changed after saving')
        }
      }
      await assertCurrent()
      if (credentialsChanged && provider === 'tinfoil') {
        useSearchProviderStore.getState().configureProviderSearch(id, 'available', { select: false })
      }
      if (credentialsChanged && provider === 'otari' && connection?.enabled !== 0) {
        const resolved = await resolveProviderConnection(db, id)
        controller.signal.throwIfAborted()
        const status = await loadOtariSearchStatus(
          resolved.connection.url!,
          resolved.apiKey,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        )
        await assertCurrent()
        useSearchProviderStore.getState().configureProviderSearch(id, status, { select: false })
      }
      const models = await getAvailableModels(db)
      controller.signal.throwIfAborted()
      useChatStore.getState().setModels(models)
      await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
      await queryClient.invalidateQueries({ queryKey: ['models'] })
      await assertCurrent()
      onSaved(id)
    },
    onSettled: (_result, _error, controller) => {
      if (pending.current === controller) {
        pending.current = null
      }
    },
  })
  const busy = mutation.isPending || authorization.isPending
  const validationError = mutation.error instanceof ProviderConnectionValidationError ? mutation.error.kind : null
  const error = mutation.isError
    ? validationError === 'credentials'
      ? t`The API key was rejected. Check it and try again.`
      : validationError === 'timeout'
        ? t`Connection verification timed out. Try again.`
        : validationError === 'attestation'
          ? t`The provider's security verification failed. Try again.`
          : validationError === 'connection'
            ? t`Could not verify the connection. Check your network and try again.`
            : t`Could not save the connection. Try again.`
    : authorization.error
  const valid =
    Boolean(state.name.trim()) &&
    (!definition.requiresUrl || Boolean(state.url.trim())) &&
    (!credentialsChanged || state.authMethod === 'oauth' || provider === 'custom' || Boolean(state.apiKey.trim())) &&
    (!editing || state.name.trim() !== connection?.name || credentialsChanged)
  const submit = () => {
    if (!valid || busy || pending.current) {
      return
    }
    if (!editing && state.authMethod === 'oauth' && definition.oauth) {
      void authorization.authorize({
        provider: provider as OAuthProviderType,
        name: existingOAuth?.name ?? state.name.trim(),
        url: existingOAuth?.url ?? state.url,
        id: existingOAuth?.id ?? connection?.id,
      })
      return
    }
    const controller = createIdentityController()
    pending.current = controller
    mutation.mutate(controller)
  }
  return {
    ...state,
    definition,
    editing,
    oauthLocked,
    urlChanged,
    busy,
    valid,
    dispatch,
    submit,
    error,
  }
}
