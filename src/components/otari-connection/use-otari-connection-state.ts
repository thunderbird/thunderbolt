/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef, useState, useEffectEvent } from 'react'
import { useLingui } from '@lingui/react/macro'
import { i18n } from '@/i18n'
import { useDatabase } from '@/contexts'
import {
  assertProviderConnectionAttemptCurrent,
  getProviderConnectionAttempt,
  type ProviderConnectionAttempt,
} from '@/lib/provider-connection-attempt'
import {
  cancelOtariBrowserConnection,
  clearOtariBrowserReturn,
  getOtariBrowserReturn,
  getOtariBrowserDraft,
  discardOtariBrowserDraft,
  startOtariBrowserConnection,
  type OtariReturnContext,
} from '@/lib/otari-browser-auth'
import { isMobile, isTauri } from '@/lib/platform'
import { connectOtari, defaultOtariOrigin, getOtariEndpoints, normalizeOtariOrigin } from '@/lib/otari-auth'
import { createDefaultProbe } from '@/hooks/use-model-connection-test'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { http } from '@/lib/http'
import { fetch as nativeFetch } from '@/lib/fetch'
import {
  saveProviderConnection,
  disconnectProviderConnection,
  resolveProviderConnection,
} from '@/dal/provider-connections'
import { addProviderModels } from '@/providers/models'
import { discardOtariAuthorization } from '@/providers/otari-session'
import { getAvailableModels, updateSettings } from '@/dal'
import { useChatStore } from '@/chats/chat-store'
import { useQueryClient } from '@tanstack/react-query'
import type { AvailableModel } from '@/settings/models/model-catalog'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { loadOtariSearchStatus, type OtariSearchStatus } from '@/integrations/otari-search/capabilities'
import { createIdentityController } from '@/lib/identity-lifetime'

type ConnectionController = ReturnType<typeof createIdentityController> & { returnId?: string }

type State = {
  origin: string
  isCustomUrl: boolean
  operation: 'connect' | 'models' | 'save' | 'disconnect' | null
  key: string
  connectionId: string | null
  connectionUpdatedAt: string | null
  attempt: ProviderConnectionAttempt | null
  models: AvailableModel[]
  modelsLoaded: boolean
  searchStatus: OtariSearchStatus | null
  selected: string
  error: string
}

/** Read the workspace catalog using only the app's delegated credential. */
const loadOtariModels = async (origin: string, key: string, signal: AbortSignal) => {
  const catalog = await http
    .get(`${getOtariEndpoints(origin).inference}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      credentials: 'omit',
      redirect: 'error',
      fetch: nativeFetch,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    .json<{ data: AvailableModel[] }>()
  return catalog.data
}

/** Desktop uses loopback; web and mobile preserve the request across browser redirects. */
const beginConnection = async (
  origin: string,
  signal: AbortSignal,
  context: OtariReturnContext,
  attempt: ProviderConnectionAttempt,
) => {
  if (isTauri() && !isMobile()) {
    return connectOtari(origin, signal)
  }
  await startOtariBrowserConnection(origin, context, signal, attempt)
  return null
}
const connectionDependencies = { connect: beginConnection, loadModels: loadOtariModels }

/** Connects Otari independently, then selects an initial model for onboarding. */
export const useOtariConnectionState = (
  onSaved?: () => void,
  dependencies = connectionDependencies,
  context: OtariReturnContext = 'models',
) => {
  const { t } = useLingui()
  const db = useDatabase()
  const getProxyFetch = useProxyFetchGetter()
  const queryClient = useQueryClient()
  const [returned] = useState(() => getOtariBrowserReturn(context))
  const [draft] = useState(() => getOtariBrowserDraft(context))
  const initialOrigin = returned?.origin ?? draft?.origin ?? defaultOtariOrigin
  const [state, update] = useReducer((state: State, action: Partial<State>) => ({ ...state, ...action }), {
    origin: initialOrigin,
    isCustomUrl: initialOrigin !== defaultOtariOrigin,
    operation: returned ? 'connect' : null,
    key: '',
    connectionId: null,
    connectionUpdatedAt: null,
    attempt: null,
    models: [],
    modelsLoaded: false,
    searchStatus: null,
    selected: '',
    error: '',
  })
  const pending = useRef<ConnectionController | null>(null)

  const loadAuthorizedModels = async (
    origin: string,
    key: string,
    attempt: ProviderConnectionAttempt,
    controller: ConnectionController,
  ) => {
    controller.signal.throwIfAborted()
    const searchSelection = useSearchProviderStore.getState()
    const connectionId =
      state.connectionId ??
      (await saveProviderConnection(db, {
        provider: 'otari',
        name: 'Otari',
        url: getOtariEndpoints(origin).inference,
        authMethod: 'oauth',
        credentials: { access_token: key },
        attempt,
        signal: controller.signal,
      }))
    const { connection, apiKey } = await resolveProviderConnection(db, connectionId)
    if (connection.url !== getOtariEndpoints(origin).inference || apiKey !== key) {
      throw new Error('The provider connection changed. Connect again to load its models.')
    }
    controller.signal.throwIfAborted()
    update({ key, attempt, origin, connectionId, connectionUpdatedAt: connection.updatedAt, operation: 'models' })
    try {
      const [models, searchStatus] = await Promise.all([
        dependencies.loadModels(origin, key, controller.signal),
        loadOtariSearchStatus(getOtariEndpoints(origin).inference, key, controller.signal),
      ])
      const current = await resolveProviderConnection(db, connectionId)
      if (current.connection.updatedAt !== connection.updatedAt || current.apiKey !== key) {
        throw new Error('The provider connection changed while loading models.')
      }
      controller.signal.throwIfAborted()
      const currentSearch = useSearchProviderStore.getState()
      currentSearch.configureProviderSearch(connectionId, searchStatus, {
        select:
          currentSearch.selection === searchSelection.selection &&
          currentSearch.connectionId === searchSelection.connectionId,
      })
      update({
        models,
        modelsLoaded: true,
        searchStatus,
        selected: models.some((model) => model.id === state.selected) ? state.selected : (models[0]?.id ?? ''),
      })
    } catch {
      if (!controller.signal.aborted) {
        update({ error: t`Connected to Otari, but couldn't load your models. Please try again.` })
      }
    }
  }

  const loadModels = async (
    origin: string,
    key: string,
    attempt: ProviderConnectionAttempt,
    controller: ConnectionController,
  ) => {
    try {
      await loadAuthorizedModels(origin, key, attempt, controller)
    } catch (error) {
      // A shared redirect result can transfer to StrictMode's replacement effect.
      const transferred =
        returned &&
        pending.current !== controller &&
        pending.current?.returnId === returned.id &&
        !pending.current.signal.aborted
      if (!transferred) {
        await discardOtariAuthorization(db, origin, key)
      }
      throw error
    }
  }

  // The callback owns a single exchange; StrictMode can subscribe again without replaying the code.
  const resume = useEffectEvent(async (controller: ConnectionController) => {
    if (!returned) {
      return
    }
    try {
      await assertProviderConnectionAttemptCurrent(db, returned.attempt)
      controller.signal.throwIfAborted()
      const key = await returned.complete()
      await loadModels(returned.origin, key, returned.attempt, controller)
    } catch {
      if (!controller.signal.aborted) {
        update({ error: returned.error ? i18n._(returned.error) : t`Could not connect to Otari. Please try again.` })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        update({ operation: null })
      }
      controller.abort()
    }
  })
  useEffect(() => {
    if (draft) {
      discardOtariBrowserDraft(draft.id)
    }
    if (returned) {
      clearOtariBrowserReturn(returned.id)
      const controller = { ...createIdentityController(), returnId: returned.id }
      pending.current = controller
      void resume(controller)
    }
    return () => pending.current?.abort()
  }, [draft, returned])

  const connect = async () => {
    if (pending.current) {
      return
    }
    const origin = (() => {
      try {
        return normalizeOtariOrigin(state.origin.trim())
      } catch {
        update({ error: t`Enter a valid HTTPS server URL, or an HTTP localhost URL for local development.` })
        return null
      }
    })()
    if (!origin) {
      return
    }
    const controller = createIdentityController()
    pending.current = controller
    update({ operation: state.key ? 'models' : 'connect', error: '' })
    try {
      const attempt = state.attempt ?? (await getProviderConnectionAttempt(db, 'otari'))
      controller.signal.throwIfAborted()
      const key = state.key || (await dependencies.connect(origin, controller.signal, context, attempt))
      if (!key) {
        return
      }
      await loadModels(origin, key, attempt, controller)
    } catch {
      if (!controller.signal.aborted) {
        update({ error: t`Could not connect to Otari. Please try again.` })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        update({ operation: null })
      }
      controller.abort()
    }
  }

  const save = async () => {
    if (pending.current || !state.key || !state.attempt || !state.selected) {
      return
    }
    const controller = createIdentityController()
    pending.current = controller
    update({ error: '', operation: 'save' })
    try {
      const connection = {
        providerConnectionId: state.connectionId,
        provider: 'otari' as const,
        model: state.selected,
        url: getOtariEndpoints(state.origin).inference,
        apiKey: state.key,
      }
      const tools = await createDefaultProbe()(
        connection,
        getProxyFetch,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      )
      controller.signal.throwIfAborted()
      const { connectionId, connectionUpdatedAt } = state
      if (!connectionId || !connectionUpdatedAt) {
        throw new Error('Provider connection is missing')
      }
      const assertCurrent = async () => {
        controller.signal.throwIfAborted()
        const current = await resolveProviderConnection(db, connectionId)
        controller.signal.throwIfAborted()
        if (current.connection.updatedAt !== connectionUpdatedAt || current.apiKey !== state.key) {
          throw new Error('The provider connection changed while saving its model.')
        }
      }
      const [id] = await addProviderModels(
        db,
        connectionId,
        [
          {
            ...(state.models.find((model) => model.id === state.selected) ?? { id: state.selected }),
            supports_tools: tools === 'supported',
          },
        ],
        { expectedUpdatedAt: connectionUpdatedAt, signal: controller.signal },
      )
      await assertCurrent()
      await updateSettings(db, { selected_model: id }, { signal: controller.signal })
      const models = await getAvailableModels(db)
      controller.signal.throwIfAborted()
      useChatStore.getState().setModels(models)
      await queryClient.invalidateQueries({ queryKey: ['models'] })
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      await assertCurrent()
      resetConnection()
      onSaved?.()
    } catch {
      if (!controller.signal.aborted) {
        update({ error: t`Could not verify or save the Otari model. Please try again.` })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        update({ operation: null })
      }
      controller.abort()
    }
  }

  const resetConnection = (changes: Partial<State> = {}) =>
    update({
      key: '',
      connectionId: null,
      connectionUpdatedAt: null,
      attempt: null,
      models: [],
      modelsLoaded: false,
      searchStatus: null,
      selected: '',
      error: '',
      ...changes,
    })

  return {
    ...state,
    busy: state.operation !== null,
    dashboard: state.key ? getOtariEndpoints(state.origin).dashboard : '',
    connect,
    save,
    cancel: () => {
      returned?.cancel()
      cancelOtariBrowserConnection()
      pending.current?.abort()
      pending.current = null
      update({ operation: null })
    },
    reconnect: async () => {
      if (pending.current) {
        return
      }
      const controller = createIdentityController()
      pending.current = controller
      update({ operation: 'disconnect', error: '' })
      try {
        if (state.connectionId) {
          await disconnectProviderConnection(db, state.connectionId)
        }
        controller.signal.throwIfAborted()
        resetConnection()
      } catch {
        if (!controller.signal.aborted) {
          update({ error: t`Could not disconnect Otari. Please try again.` })
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null
          update({ operation: null })
        }
        controller.abort()
      }
    },
    useCustomUrl: () => resetConnection({ isCustomUrl: true, origin: '' }),
    useHosted: () => resetConnection({ isCustomUrl: false, origin: defaultOtariOrigin }),
    setOrigin: (origin: string) => resetConnection({ origin }),
    setSelected: (selected: string) => update({ selected }),
  }
}
