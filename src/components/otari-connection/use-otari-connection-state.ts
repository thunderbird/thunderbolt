/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef, useState, useEffectEvent } from 'react'
import { useLingui } from '@lingui/react/macro'
import { i18n } from '@/i18n'
import { useDatabase } from '@/contexts'
import { getProviderConnectionAttempt, type ProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import {
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
import { useAddModelForm } from '@/settings/models/use-add-model-form'
import type { AvailableModel } from '@/settings/models/model-catalog'
import { getModelDisplayName } from '@/settings/models/model-display-name'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { loadOtariSearchStatus, type OtariSearchStatus } from '@/integrations/otari-search/capabilities'

type State = {
  origin: string
  isCustomUrl: boolean
  operation: 'connect' | 'models' | 'save' | null
  key: string
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

/** Owns cancellation and keeps the issued key in memory until a model is selected. */
export const useOtariConnectionState = (
  onSaved?: () => void,
  dependencies = connectionDependencies,
  context: OtariReturnContext = 'models',
) => {
  const { t } = useLingui()
  const db = useDatabase()
  const getProxyFetch = useProxyFetchGetter()
  const [returned] = useState(() => getOtariBrowserReturn(context))
  const [draft] = useState(() => getOtariBrowserDraft(context))
  const initialOrigin = returned?.origin ?? draft?.origin ?? defaultOtariOrigin
  const [state, update] = useReducer((state: State, action: Partial<State>) => ({ ...state, ...action }), {
    origin: initialOrigin,
    isCustomUrl: initialOrigin !== defaultOtariOrigin,
    operation: returned ? 'connect' : null,
    key: '',
    attempt: null,
    models: [],
    modelsLoaded: false,
    searchStatus: null,
    selected: '',
    error: '',
  })
  const pending = useRef<AbortController | null>(null)
  const form = useAddModelForm({ isOpen: false, onClose: () => {} })

  const loadModels = async (
    origin: string,
    key: string,
    attempt: ProviderConnectionAttempt,
    controller: AbortController,
  ) => {
    controller.signal.throwIfAborted()
    update({ key, attempt, origin, operation: 'models' })
    try {
      const [models, searchStatus] = await Promise.all([
        dependencies.loadModels(origin, key, controller.signal),
        loadOtariSearchStatus(getOtariEndpoints(origin).inference, key, controller.signal),
      ])
      controller.signal.throwIfAborted()
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

  // The callback owns a single exchange; StrictMode can subscribe again without replaying the code.
  const resume = useEffectEvent(async (controller: AbortController) => {
    if (!returned) {
      return
    }
    try {
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
      const controller = new AbortController()
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
    const controller = new AbortController()
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
    const controller = new AbortController()
    pending.current = controller
    update({ error: '', operation: 'save' })
    try {
      const connection = {
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
      const { id } = await form.saveModel({
        ...connection,
        providerDefault: 1,
        providerAuthorization: { attempt: state.attempt },
        name: getModelDisplayName(state.models.find((model) => model.id === state.selected) ?? { id: state.selected }),
        supportsTools: tools === 'supported',
        signal: controller.signal,
      })
      controller.signal.throwIfAborted()
      useSearchProviderStore
        .getState()
        .configureOtariSearch({ modelId: id, url: connection.url, searchStatus: state.searchStatus ?? 'unknown' })
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
    busy: state.operation !== null || form.isPending,
    dashboard: state.key ? getOtariEndpoints(state.origin).dashboard : '',
    connect,
    save,
    cancel: () => {
      returned?.cancel()
      pending.current?.abort()
      pending.current = null
      update({ operation: null })
    },
    reconnect: () => resetConnection(),
    useCustomUrl: () => resetConnection({ isCustomUrl: true, origin: '' }),
    useHosted: () => resetConnection({ isCustomUrl: false, origin: defaultOtariOrigin }),
    setOrigin: (origin: string) => resetConnection({ origin }),
    setSelected: (selected: string) => update({ selected }),
  }
}
