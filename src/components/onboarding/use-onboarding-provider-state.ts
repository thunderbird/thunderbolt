/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { providerSetupErrorMessage, runProviderSetupStage } from './provider-setup-error'
import { useLingui } from '@lingui/react/macro'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import {
  exchangeOpenRouterCode,
  prepareOpenRouterManualConnection,
  startOpenRouterConnection,
  type OpenRouterManualConnection,
} from '@/lib/openrouter-auth'
import { tinfoilAuth, TinfoilConnectionError } from '@/lib/tinfoil-auth'
import {
  startTinfoilMobileConnection,
  cancelTinfoilMobileConnection,
  getTinfoilMobileReturn,
  clearTinfoilMobileReturn,
  type TinfoilReturnContext,
} from '@/lib/tinfoil-mobile-auth'
import {
  assertProviderConnectionAttemptCurrent,
  getProviderConnectionAttempt,
  type ProviderAuthorization,
  type ProviderConnectionAttempt,
} from '@/lib/provider-connection-attempt'
import { useDatabase } from '@/contexts'
import { isMobile, isTauri } from '@/lib/platform'
import { useAddModelForm } from '@/settings/models/use-add-model-form'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { prepareProviderDefaultModel, type OnboardingProvider } from './provider-default-model'

type SetupView = 'choices' | 'openrouter' | 'tinfoil' | 'otari' | 'other' | 'manual'
type ProviderState = {
  selection: OnboardingProvider | 'otari' | 'custom'
  view: SetupView
  isConnecting: boolean
  isDisconnecting: boolean
  showApiKey: boolean
  error: string | null
  manual: (OpenRouterManualConnection & { attempt: ProviderConnectionAttempt }) | null
  code: string
}
type ProviderAction =
  | { type: 'select'; selection: ProviderState['selection'] }
  | { type: 'view'; view: SetupView }
  | { type: 'connecting' }
  | { type: 'disconnecting' }
  | { type: 'api-key' }
  | { type: 'error'; error: string }
  | { type: 'manual'; manual: OpenRouterManualConnection & { attempt: ProviderConnectionAttempt } }
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
  startTinfoilMobile: startTinfoilMobileConnection,
}

/** Coordinates provider authorization and the existing tested-model save flow. */
export const useOnboardingProviderState = (
  connectedProviders: readonly ProviderState['selection'][],
  dependencies = connectionDependencies,
  onConnected?: () => void,
  options: {
    initialProvider?: ProviderState['selection']
    initialView?: SetupView
    onSaved?: () => void
    returnContext?: TinfoilReturnContext
  } = {},
) => {
  const { t, i18n } = useLingui()
  const db = useDatabase()
  const getProxyFetch = useProxyFetchGetter()
  const [returned] = useState(() => getTinfoilMobileReturn(options.returnContext ?? 'onboarding'))
  const [state, dispatch] = useReducer(onboardingProviderReducer, {
    selection: returned ? 'tinfoil' : (options.initialProvider ?? connectedProviders[0] ?? 'openrouter'),
    view: returned ? 'tinfoil' : (options.initialView ?? 'choices'),
    isConnecting: false,
    isDisconnecting: false,
    showApiKey: false,
    error: null,
    manual: null,
    code: '',
  })
  const authorizedSession = useRef<{ key: string; authorization: ProviderAuthorization } | null>(null)
  const pending = useRef<AbortController | null>(null)
  const isFormOpen = state.view === 'other'
  const provider: OnboardingProvider = state.selection === 'tinfoil' ? 'tinfoil' : 'openrouter'
  const isConnected = connectedProviders.includes(state.selection)
  const addForm = useAddModelForm({
    isOpen: state.view === 'other',
    onClose: () => dispatch({ type: 'view', view: state.view === 'other' ? 'choices' : provider }),
    onSaved: () => {
      options.onSaved?.()
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
    authorization?: ProviderAuthorization,
  ) => {
    try {
      const currentAuthorization = authorization ?? { attempt: await getProviderConnectionAttempt(db, provider) }
      await runProviderSetupStage('save', () =>
        assertProviderConnectionAttemptCurrent(db, currentAuthorization.attempt),
      )
      controller.signal.throwIfAborted()
      const values = await dependencies.prepareModel(provider, key, getProxyFetch, controller.signal)
      if (!controller.signal.aborted) {
        await runProviderSetupStage('save', () =>
          addForm.saveModel({
            ...values,
            signal: controller.signal,
            providerAuthorization: currentAuthorization,
            ...(currentAuthorization.tinfoilCredentials ? { oauthProvider: 'tinfoil' } : {}),
          }),
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
    authorization: ProviderAuthorization,
  ) => {
    authorizedSession.current = { key, authorization }
    addForm.onProviderChange(provider)
    addForm.form.setValue('apiKey', key, { shouldValidate: true })
    dispatch({ type: 'view', view: provider })
    dispatch({ type: 'connecting' })
    await saveProvider(provider, key, controller, authorization)
  }

  const connectProvider = async (provider: OnboardingProvider) => {
    dispatch({ type: 'select', selection: provider })
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    dispatch({ type: 'connecting' })
    try {
      const attempt = await getProviderConnectionAttempt(db, provider)
      controller.signal.throwIfAborted()
      if (provider === 'tinfoil' && dependencies.needsManual()) {
        await dependencies.startTinfoilMobile(options.returnContext ?? 'onboarding', attempt, controller.signal)
        return
      }
      if (provider !== 'tinfoil' && dependencies.needsManual()) {
        const manual = await dependencies.prepareManual()
        if (controller.signal.aborted) {
          return
        }
        await dependencies.openUrl(manual.authorizationUrl)
        if (!controller.signal.aborted) {
          dispatch({ type: 'manual', manual: { ...manual, attempt } })
        }
        return
      }
      if (provider === 'tinfoil') {
        const cached = authorizedSession.current?.authorization
        const authorization =
          !isConnected &&
          cached?.attempt.revision === attempt.revision &&
          cached.tinfoilCredentials &&
          cached.tinfoilCredentials.expires_at > Date.now() + 60_000
            ? { tinfoilCredentials: cached.tinfoilCredentials, attempt: cached.attempt }
            : { tinfoilCredentials: await dependencies.startTinfoil({ signal: controller.signal }), attempt }
        if (!controller.signal.aborted) {
          await connectKey(provider, authorization.tinfoilCredentials.access_token, controller, authorization)
        }
      } else {
        const key = await dependencies.start({ signal: controller.signal })
        if (!controller.signal.aborted) {
          await connectKey(provider, key, controller, { attempt })
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

  const resumeMobile = useEffectEvent(async (controller: AbortController) => {
    if (!returned) {
      return
    }
    dispatch({ type: 'connecting' })
    try {
      await assertProviderConnectionAttemptCurrent(db, returned.attempt)
      controller.signal.throwIfAborted()
      const credentials = await returned.complete()
      controller.signal.throwIfAborted()
      await connectKey('tinfoil', credentials.access_token, controller, {
        attempt: returned.attempt,
        tinfoilCredentials: credentials,
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        dispatch({
          type: 'error',
          error:
            error instanceof TinfoilConnectionError
              ? error.message
              : t`Could not connect to Tinfoil. Try again, or use an API key.`,
        })
      }
    }
  })

  // Native returns remount setup. A shared exchange survives StrictMode's effect replay.
  useEffect(() => {
    if (!returned) {
      return
    }
    clearTinfoilMobileReturn(returned.id)
    const controller = new AbortController()
    pending.current = controller
    void resumeMobile(controller)
    return () => controller.abort()
  }, [returned])

  const submitCode = async () => {
    if (!state.manual || !state.code.trim()) {
      return
    }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    dispatch({ type: 'connecting' })
    try {
      await assertProviderConnectionAttemptCurrent(db, state.manual.attempt)
      controller.signal.throwIfAborted()
      const key = await dependencies.exchange(state.code, state.manual.verifier, controller.signal)
      if (!controller.signal.aborted) {
        await connectKey(provider, key, controller, { attempt: state.manual.attempt })
      }
    } catch {
      if (!controller.signal.aborted) {
        dispatch({ type: 'error', error: t`Could not verify this code. Try again or start a new connection.` })
      }
    }
  }

  const cancelAuthorization = () => {
    cancelTinfoilMobileConnection()
    returned?.cancel()
    pending.current?.abort()
  }

  const showChoices = () => {
    cancelAuthorization()
    authorizedSession.current = null
    addForm.resetForm()
    dispatch({ type: 'view', view: 'choices' })
  }

  const chooseProvider = (provider: ProviderState['selection']) => {
    cancelAuthorization()
    addForm.onProviderChange(provider)
    dispatch({ type: 'select', selection: provider })
    dispatch({ type: 'view', view: provider === 'custom' ? 'other' : provider })
  }

  const connectApiKey = async () => {
    if (state.isConnecting || addForm.isPending) {
      return
    }
    const key = addForm.form.getValues('apiKey')?.trim()
    if (!key || state.selection === 'custom' || state.selection === 'otari') {
      return
    }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    dispatch({ type: 'connecting' })
    await saveProvider(
      provider,
      key,
      controller,
      authorizedSession.current?.key === key && authorizedSession.current.authorization.attempt.provider === provider
        ? authorizedSession.current.authorization
        : undefined,
    )
  }

  const cancelConnection = () => {
    cancelAuthorization()
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
    showApiKey: state.showApiKey,
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
