/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { providerSetupErrorMessage, runProviderSetupStage } from './provider-setup-error'
import { useLingui } from '@lingui/react/macro'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useReducer, useRef } from 'react'
import {
  exchangeOpenRouterCode,
  prepareOpenRouterManualConnection,
  startOpenRouterConnection,
  type OpenRouterManualConnection,
} from '@/lib/openrouter-auth'
import { tinfoilAuth, TinfoilConnectionError, type TinfoilCredentials } from '@/lib/tinfoil-auth'
import { isMobile, isTauri } from '@/lib/platform'
import { useAddModelForm } from '@/settings/models/use-add-model-form'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { prepareProviderDefaultModel, type OnboardingProvider } from './provider-default-model'

type SetupView = 'choices' | 'openrouter' | 'tinfoil' | 'other' | 'manual'
type ProviderState = {
  selection: OnboardingProvider | 'custom'
  view: SetupView
  isConnecting: boolean
  isDisconnecting: boolean
  showApiKey: boolean
  error: string | null
  manual: OpenRouterManualConnection | null
  code: string
}
type ProviderAction =
  | { type: 'select'; selection: ProviderState['selection'] }
  | { type: 'view'; view: SetupView }
  | { type: 'connecting' }
  | { type: 'disconnecting' }
  | { type: 'api-key' }
  | { type: 'error'; error: string }
  | { type: 'manual'; manual: OpenRouterManualConnection }
  | { type: 'code'; code: string }

/** Keeps provider credentials in the form and transient PKCE material in memory. */
const onboardingProviderReducer = (state: ProviderState, action: ProviderAction): ProviderState => {
  switch (action.type) {
    case 'select':
      return { ...state, selection: action.selection, error: null }
    case 'view':
      return {
        ...state,
        view: action.view,
        isConnecting: false,
        isDisconnecting: false,
        showApiKey: false,
        error: null,
        manual: null,
        code: '',
      }
    case 'api-key':
      return { ...state, showApiKey: true, error: null }
    case 'disconnecting':
      return { ...state, isDisconnecting: true, error: null }
    case 'connecting':
      return { ...state, isConnecting: true, error: null }
    case 'error':
      return { ...state, isConnecting: false, isDisconnecting: false, error: action.error }
    case 'manual':
      return { ...state, view: 'manual', isConnecting: false, error: null, manual: action.manual, code: '' }
    case 'code':
      return { ...state, code: action.code }
  }
}

const connectionDependencies = {
  start: startOpenRouterConnection,
  prepareManual: prepareOpenRouterManualConnection,
  exchange: exchangeOpenRouterCode,
  needsManual: () => isTauri() && isMobile(),
  openUrl,
  prepareModel: prepareProviderDefaultModel,
  startTinfoil: tinfoilAuth.startConnection,
}

/** Coordinates provider authorization and the existing tested-model save flow. */
export const useOnboardingProviderState = (
  connectedProviders: readonly ProviderState['selection'][],
  dependencies = connectionDependencies,
  onConnected?: () => void,
) => {
  const { t, i18n } = useLingui()
  const getProxyFetch = useProxyFetchGetter()
  const [state, dispatch] = useReducer(onboardingProviderReducer, {
    selection: connectedProviders[0] ?? 'openrouter',
    view: 'choices',
    isConnecting: false,
    isDisconnecting: false,
    showApiKey: false,
    error: null,
    manual: null,
    code: '',
  })
  const authorizedSession = useRef<TinfoilCredentials | null>(null)
  const pending = useRef<AbortController | null>(null)
  const isFormOpen = state.view === 'other'
  const provider: OnboardingProvider = state.selection === 'tinfoil' ? 'tinfoil' : 'openrouter'
  const isConnected = connectedProviders.includes(state.selection)
  const addForm = useAddModelForm({
    isOpen: state.view === 'other',
    onClose: () => dispatch({ type: 'view', view: state.view === 'other' ? 'choices' : provider }),
    onSaved: () => {
      if (state.view === 'other') {
        onConnected?.()
      }
    },
  })

  // Authorization owns browser/native listeners and requests that must stop when this step unmounts.
  useEffect(() => () => pending.current?.abort(), [])

  const saveProvider = async (
    provider: OnboardingProvider,
    key: string,
    controller: AbortController,
    tokens?: TinfoilCredentials,
  ) => {
    try {
      const values = await dependencies.prepareModel(provider, key, getProxyFetch, controller.signal)
      if (!controller.signal.aborted) {
        await runProviderSetupStage('save', () =>
          addForm.saveModel(tokens ? { ...values, oauthProvider: 'tinfoil', tinfoilCredentials: tokens } : values),
        )
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        dispatch({
          type: 'error',
          error: i18n._(providerSetupErrorMessage(error)),
        })
      }
    }
  }

  const connectKey = async (
    provider: OnboardingProvider,
    key: string,
    controller: AbortController,
    tokens?: TinfoilCredentials,
  ) => {
    authorizedSession.current = tokens ?? null
    addForm.onProviderChange(provider)
    addForm.form.setValue('apiKey', key, { shouldValidate: true })
    dispatch({ type: 'view', view: provider })
    dispatch({ type: 'connecting' })
    await saveProvider(provider, key, controller, tokens)
  }

  const connectProvider = async (provider: OnboardingProvider) => {
    dispatch({ type: 'select', selection: provider })
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    dispatch({ type: 'connecting' })
    try {
      if (provider !== 'tinfoil' && dependencies.needsManual()) {
        const manual = await dependencies.prepareManual()
        if (controller.signal.aborted) {
          return
        }
        await dependencies.openUrl(manual.authorizationUrl)
        if (!controller.signal.aborted) {
          dispatch({ type: 'manual', manual })
        }
        return
      }
      if (provider === 'tinfoil') {
        const cached = authorizedSession.current
        const tokens =
          !isConnected && cached && cached.expires_at > Date.now() + 60_000
            ? cached
            : await dependencies.startTinfoil({ signal: controller.signal })
        if (!controller.signal.aborted) {
          await connectKey(provider, tokens.access_token, controller, tokens)
        }
      } else {
        const key = await dependencies.start({ signal: controller.signal })
        if (!controller.signal.aborted) {
          await connectKey(provider, key, controller)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        dispatch({
          type: 'error',
          error:
            error instanceof TinfoilConnectionError
              ? error.message
              : provider === 'tinfoil'
                ? t`Could not connect to Tinfoil. Try again, or use an API key.`
                : t`Could not connect to OpenRouter. Try again, or use an API key.`,
        })
      }
    }
  }

  const submitCode = async () => {
    if (!state.manual || !state.code.trim()) {
      return
    }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    dispatch({ type: 'connecting' })
    try {
      const key = await dependencies.exchange(state.code, state.manual.verifier, controller.signal)
      if (!controller.signal.aborted) {
        await connectKey(provider, key, controller)
      }
    } catch {
      if (!controller.signal.aborted) {
        dispatch({ type: 'error', error: t`Could not verify this code. Try again or start a new connection.` })
      }
    }
  }

  const showChoices = () => {
    pending.current?.abort()
    authorizedSession.current = null
    addForm.resetForm()
    dispatch({ type: 'view', view: 'choices' })
  }

  const chooseProvider = (provider: 'tinfoil' | 'custom' | 'openrouter') => {
    pending.current?.abort()
    addForm.onProviderChange(provider)
    dispatch({ type: 'select', selection: provider })
    dispatch({ type: 'view', view: provider === 'custom' ? 'other' : provider })
  }

  const connectApiKey = async () => {
    if (state.isConnecting || addForm.isPending) {
      return
    }
    const key = addForm.form.getValues('apiKey')?.trim()
    if (!key || (state.view !== 'openrouter' && state.view !== 'tinfoil')) {
      return
    }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    dispatch({ type: 'connecting' })
    await saveProvider(
      state.view,
      key,
      controller,
      authorizedSession.current?.access_token === key ? authorizedSession.current : undefined,
    )
  }

  const cancelConnection = () => {
    pending.current?.abort()
    authorizedSession.current = null
    addForm.resetForm()
    dispatch({ type: 'view', view: provider })
  }

  const disconnectProvider = async (disconnect: () => Promise<void>) => {
    dispatch({ type: 'disconnecting' })
    try {
      await disconnect()
      authorizedSession.current = null
      addForm.resetForm()
      dispatch({ type: 'view', view: provider })
    } catch {
      dispatch({ type: 'error', error: t`Could not disconnect this provider. Please try again.` })
    }
  }

  const continueSelection = () => {
    if (state.isConnecting || state.isDisconnecting || addForm.isPending) {
      return
    }
    if (state.view === 'choices') {
      chooseProvider(state.selection)
      return
    }
    if (isConnected) {
      onConnected?.()
    }
  }

  return {
    ...state,
    addForm,
    isFormOpen,
    connectOpenRouter: () => connectProvider('openrouter'),
    connectTinfoil: () => connectProvider('tinfoil'),
    connectSelectedProvider: () => connectProvider(provider),
    cancelConnection,
    disconnectProvider,
    isConnected,
    provider,
    useApiKey: () => {
      authorizedSession.current = null
      addForm.form.setValue('apiKey', '')
      dispatch({ type: 'api-key' })
    },
    submitCode,
    showChoices,
    chooseProvider,
    continueSelection,
    connectApiKey,
    selectProvider: (selection: ProviderState['selection']) => dispatch({ type: 'select', selection }),
    setCode: (code: string) => dispatch({ type: 'code', code }),
  }
}
