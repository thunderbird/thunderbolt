/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal/settings'
import { StrictMode } from 'react'
import { msg } from '@lingui/core/macro'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getAllModels, getAvailableModels, getSettings } from '@/dal'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import * as modelProbe from '@/hooks/use-model-connection-test'
import * as otariBrowser from '@/lib/otari-browser-auth'
import * as providerModels from '@/providers/models'
import { getProviderConnectionAttempt, type ProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import {
  disconnectProviderConnection,
  getProviderCredentials,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { http } from '@/lib/http'
import { i18n } from '@/i18n'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { stubJsonResponse } from '@/test-utils/http'
import { createTestProvider } from '@/test-utils/test-provider'
import { rejectNestedTransactions } from '@/test-utils/flat-transactions'
import { getClock } from '@/testing-library'
import type { AvailableModel } from '@/settings/models/model-catalog'
import OnboardingModelStep from '@/components/onboarding/onboarding-model-step'
import { useOtariConnectionState } from './use-otari-connection-state'

describe('Otari connection', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    await updateSettings(getDb(), { experimental_feature_otari: true })
    rejectNestedTransactions(getDb())
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true, serverHasAuthenticated: false, syncEnabled: false })
    spyOn(http, 'get').mockImplementation((url) =>
      stubJsonResponse({
        data: url.endsWith('/tools')
          ? [{ id: 'otari_web_search', available: true, direct_available: true }]
          : [{ id: 'example/model', name: 'Example Model' }],
      }),
    )
  })

  afterEach(() => {
    cleanup()
    mock.restore()
    resetStore()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterAll(teardownTestDatabase)

  it('offers Otari below Tinfoil, with a separate step and an optional custom URL', async () => {
    render(<OnboardingModelStep />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'OpenRouter',
      'Tinfoil',
      'Otari',
      'Other provider',
    ])
    expect(screen.getByText('Sign in to connect Otari.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Otari' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Otari' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Connect Otari' })).toBeEnabled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('Connect to the official Otari server.')).toBeInTheDocument()
    expect(screen.queryByText(/Your provider keys stay in Otari/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Custom URL' }))
    expect(screen.getByLabelText('Otari server URL')).toHaveValue('')
    expect(screen.getByLabelText('Otari server URL')).toHaveFocus()
    expect(screen.getByText('Connect to your Otari server.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Otari server URL'), { target: { value: 'http://localhost:8099' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use the official Otari server' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('radio', { name: 'Otari' })).toBeChecked()
  })

  it('resumes an Otari return once in StrictMode, restoring its custom server and catalog', async () => {
    const exchange = Promise.withResolvers<string>()
    const complete = mock(() => exchange.promise)
    const returned = {
      id: 'resume-state',
      origin: 'http://localhost:8099',
      context: 'onboarding' as const,
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: null,
      complete,
      cancel: mock(() => {}),
    }
    const readReturn = spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue(returned)
    const deps = { connect: mock(async () => 'unused'), loadModels: mock(async () => [{ id: 'workspace/model' }]) }
    const Provider = createTestProvider()
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps, 'onboarding'), {
      wrapper: ({ children }) => (
        <StrictMode>
          <Provider>{children}</Provider>
        </StrictMode>
      ),
    })
    expect(result.current.busy).toBe(true)
    expect(result.current.origin).toBe('http://localhost:8099')
    expect(result.current.isCustomUrl).toBe(true)
    await act(async () => {
      exchange.resolve('delegated-key')
      await getClock().tickAsync(0)
    })
    expect(result.current.selected).toBe('workspace/model')
    expect(result.current.key).toBe('delegated-key')
    expect(result.current.busy).toBe(false)
    expect(deps.loadModels).toHaveBeenCalledTimes(1)
    expect(deps.connect).not.toHaveBeenCalled()
    readReturn.mockRestore()
  })

  it('returns cancelled Otari authorization directly to its setup step', async () => {
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'cancelled-state',
      origin: 'http://localhost:8099',
      context: 'onboarding',
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: msg`Connection cancelled.`,
      complete: async () => {
        throw new Error('cancelled')
      },
      cancel: () => {},
    })
    render(<OnboardingModelStep />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    expect(screen.getByRole('heading', { name: 'Connect Otari' })).toBeInTheDocument()
    expect(screen.getByLabelText('Otari server URL')).toHaveValue('http://localhost:8099')
    expect(screen.getByText(i18n._(msg`Connection cancelled.`))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Otari' })).toBeEnabled()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('translates callback error copy when setup resumes under another locale', async () => {
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'cancelled-state',
      origin: 'https://otari.ai',
      context: 'models',
      returnTo: '/settings/models',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: msg`Connection cancelled.`,
      complete: async () => {
        throw new Error('Otari authorization failed')
      },
      cancel: () => {},
    })
    const previousLocale = i18n.locale
    try {
      i18n.loadAndActivate({ locale: 'de', messages: { 'Connection cancelled.': 'Verbindung abgebrochen.' } })
      const { result } = renderHook(() => useOtariConnectionState(), { wrapper: createTestProvider() })
      await act(async () => getClock().runAllAsync())
      expect(result.current.error).toBe('Verbindung abgebrochen.')
    } finally {
      i18n.activate(previousLocale)
    }
  })

  it('uses the footer Continue to verify and save the selected Otari model', async () => {
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'ready-state',
      origin: 'http://localhost:8099',
      context: 'onboarding',
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: null,
      complete: async () => 'otari-key',
      cancel: () => {},
    })
    const verification = Promise.withResolvers<'supported'>()
    const probe = mock(() => verification.promise)
    spyOn(modelProbe, 'createDefaultProbe').mockReturnValue(probe)
    const onContinue = mock(() => {
      expect(useSearchProviderStore.getState().selection).toBe('connection')
      expect(useSearchProviderStore.getState().connectionId).toBe('oauth:otari')
    })
    render(<OnboardingModelStep onContinue={onContinue} />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    expect(screen.getByText('Connected to Otari')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Choose a model' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Use this model' })).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).toBeEnabled()
    expect(button.closest('section')).toBeNull()
    expect(onContinue).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Checking model…' })).toBeDisabled()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ providerConnectionId: 'oauth:otari' }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
    await act(async () => {
      verification.resolve('supported')
      await getClock().runAllAsync()
    })
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect((await getAvailableModels(getDb()))[0]).toMatchObject({
      provider: 'otari',
      model: 'example/model',
      name: 'Example Model',
      apiKey: 'otari-key',
      url: 'http://localhost:8099/api/v1',
    })
    expect((await getAvailableModels(getDb()))[0].providerConnectionId).toBe('oauth:otari')
    expect(useSearchProviderStore.getState().connectionId).toBe('oauth:otari')
  })

  it('searches the Otari catalog and disconnects through the connected button', async () => {
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'search-state',
      origin: 'http://localhost:8099',
      context: 'onboarding',
      returnTo: '/chats/new',
      attempt: await getProviderConnectionAttempt(getDb(), 'otari'),
      error: null,
      complete: async () => 'otari-key',
      cancel: () => {},
    })
    spyOn(http, 'get').mockReturnValue(
      stubJsonResponse({ data: [{ id: 'example/model' }, { id: 'deepseek/deepseek-v4.1-flash' }] }),
    )
    render(<OnboardingModelStep />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    const disconnect = screen.getByRole('button', { name: 'Disconnect' })
    expect(disconnect).toHaveTextContent('Connected to Otari')
    expect(screen.queryByRole('button', { name: 'Connect another account' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox', { name: 'Choose a model' }))
    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'no-such-model' } })
    await act(async () => getClock().runAllAsync())
    expect(screen.getByText('No models found.')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'deepseek' } })
    await act(async () => getClock().runAllAsync())
    expect(screen.queryByRole('option', { name: 'example/model' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Deepseek v4.1 Flash deepseek/deepseek-v4.1-flash' }))
    expect(screen.getByRole('combobox', { name: 'Choose a model' })).toHaveTextContent('Deepseek v4.1 Flash')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    fireEvent.mouseEnter(disconnect)
    expect(disconnect).toHaveTextContent('Disconnect')
    await act(async () => fireEvent.click(disconnect))
    expect(await getProviderCredentials(getDb(), 'oauth:otari')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect Otari' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Otari server URL')).toHaveValue('http://localhost:8099')
  })

  it('refreshes an empty Otari catalog without requesting another OAuth grant', async () => {
    const deps = { connect: mock(async () => 'otari-key'), loadModels: mock(async () => [] as AvailableModel[]) }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
    expect(result.current.origin).toBe('https://otari.ai')
    await act(async () => result.current.connect())
    expect(result.current.key).toBe('otari-key')
    expect(result.current.modelsLoaded).toBe(true)
    expect(result.current.error).toBe('')
    deps.loadModels.mockResolvedValue([{ id: 'provider/new-model' }])
    await act(async () => result.current.connect())
    expect(deps.connect).toHaveBeenCalledTimes(1)
    expect(result.current.selected).toBe('provider/new-model')
  })

  it('keeps Otari authorization when the catalog request fails and retries it', async () => {
    const deps = {
      connect: mock(async () => 'otari-key'),
      loadModels: mock(async (): Promise<AvailableModel[]> => {
        throw new Error('offline')
      }),
    }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connect())
    expect(result.current.key).toBe('otari-key')
    expect(result.current.error).toContain("couldn't load your models")
    deps.loadModels.mockResolvedValue([{ id: 'provider/model' }])
    await act(async () => result.current.connect())
    expect(deps.connect).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBe('')
    expect(result.current.selected).toBe('provider/model')
  })

  it('records discovered search capability without overriding a newer search selection', async () => {
    const catalog = Promise.withResolvers<AvailableModel[]>()
    const started = Promise.withResolvers<void>()
    const deps = {
      connect: mock(async () => 'key'),
      loadModels: mock(() => {
        started.resolve()
        return catalog.promise
      }),
    }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
    const connecting = result.current.connect()
    await started.promise
    useSearchProviderStore.getState().selectSearchProvider('none')
    await act(async () => {
      catalog.resolve([{ id: 'model' }])
      await connecting
    })
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection: 'none',
      connectionId: null,
      connectionStatus: { connectionId: 'oauth:otari', status: 'available' },
    })
  })

  it('ignores an Otari authorization completed after cancellation', async () => {
    const deferred = Promise.withResolvers<string>()
    const deps = { connect: mock(() => deferred.promise), loadModels: mock(async () => [{ id: 'model' }]) }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
    act(() => {
      void result.current.connect()
    })
    act(() => result.current.cancel())
    await act(async () => deferred.resolve('late-key'))
    expect(result.current.key).toBe('')
    expect(deps.loadModels).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it('clears pending browser PKCE when setup is explicitly cancelled after navigation starts', async () => {
    const nonce = 'n'.repeat(43)
    const currentUrl = () => new URL('https://app.example/chats/new')
    const browser = {
      currentUrl,
      mobile: () => false,
      storage: () => sessionStorage,
      navigate: () => {},
      verifier: () => nonce,
    }
    const deps = {
      connect: async (
        origin: string,
        signal: AbortSignal,
        context: otariBrowser.OtariReturnContext,
        attempt: ProviderConnectionAttempt,
      ) => {
        await otariBrowser.startOtariBrowserConnection(origin, context, signal, attempt, browser)
        return null
      },
      loadModels: mock(async () => []),
    }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps, 'onboarding'), {
      wrapper: createTestProvider(),
    })
    await act(async () => result.current.connect())
    expect(sessionStorage.getItem('thunderbolt.otari.authorization')).not.toBeNull()
    act(() => result.current.cancel())
    expect(sessionStorage.getItem('thunderbolt.otari.authorization')).toBeNull()
    expect(
      otariBrowser.captureOtariBrowserReturn(
        new URL(`https://app.example/oauth/otari?code=late&state=${nonce}`),
        browser,
      ),
    ).toBeNull()
  })

  it('rejects a superseded browser return before exchanging its authorization code', async () => {
    const attempt = await getProviderConnectionAttempt(getDb(), 'otari')
    await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'New account',
      authMethod: 'oauth',
      credentials: { access_token: 'current-key' },
    })
    const complete = mock(async () => 'stale-key')
    spyOn(otariBrowser, 'getOtariBrowserReturn').mockReturnValue({
      id: 'stale-return',
      origin: 'https://otari.ai',
      context: 'onboarding',
      returnTo: '/chats/new',
      attempt,
      error: null,
      complete,
      cancel: () => {},
    })
    const { result } = renderHook(() => useOtariConnectionState(undefined, undefined, 'onboarding'), {
      wrapper: createTestProvider(),
    })
    await act(async () => getClock().runAllAsync())
    expect(complete).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Could not connect to Otari. Please try again.')
    expect((await getProviderCredentials(getDb(), 'oauth:otari'))?.access_token).toBe('current-key')
  })

  it.each(['http://example.com', 'https://user:password@example.com', 'not a URL'])(
    'rejects an unsafe server URL before authorization: %s',
    async (origin) => {
      const deps = { connect: mock(async () => 'key'), loadModels: mock(async () => []) }
      const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
      act(() => result.current.setOrigin(origin))
      await act(async () => result.current.connect())
      expect(deps.connect).not.toHaveBeenCalled()
      expect(result.current.error).toContain('valid HTTPS server URL')
      expect(result.current.busy).toBe(false)
    },
  )

  it('preserves the selected model on refresh and clears a selection removed from the catalog', async () => {
    const deps = {
      connect: mock(async () => 'key'),
      loadModels: mock(async (): Promise<AvailableModel[]> => [{ id: 'first' }, { id: 'chosen' }]),
    }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connect())
    act(() => result.current.setSelected('chosen'))
    await act(async () => result.current.connect())
    expect(result.current.selected).toBe('chosen')
    deps.loadModels.mockResolvedValue([{ id: 'replacement' }])
    await act(async () => result.current.connect())
    expect(result.current.selected).toBe('replacement')
    deps.loadModels.mockResolvedValue([])
    await act(async () => result.current.connect())
    expect(result.current.selected).toBe('')
    await act(async () => result.current.save())
    expect(await getAllModels(getDb())).toEqual([])
    expect(deps.connect).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale catalog after cancellation and a new connection', async () => {
    const stale = Promise.withResolvers<AvailableModel[]>()
    const catalogStarted = Promise.withResolvers<void>()
    const deps = {
      connect: mock(async () => 'key'),
      loadModels: mock(() => {
        catalogStarted.resolve()
        return stale.promise
      }),
    }
    const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
    let connecting: Promise<void>
    await act(async () => {
      connecting = result.current.connect()
      await catalogStarted.promise
    })
    act(() => result.current.cancel())
    await act(async () => result.current.reconnect())
    deps.loadModels.mockResolvedValue([{ id: 'current' }])
    await act(async () => result.current.connect())
    await act(async () => {
      stale.resolve([{ id: 'stale' }])
      await connecting
    })
    expect(result.current.selected).toBe('current')
    expect(result.current.busy).toBe(false)
  })

  it.each(['cancel', 'unmount', 'disconnect'] as const)(
    'does not save a model after %s during verification of an already connected provider',
    async (action) => {
      const verification = Promise.withResolvers<'supported'>()
      spyOn(modelProbe, 'createDefaultProbe').mockReturnValue(() => verification.promise)
      const deps = { connect: mock(async () => 'key'), loadModels: mock(async () => [{ id: 'model' }]) }
      const onSaved = mock(() => {})
      const { result, unmount } = renderHook(() => useOtariConnectionState(onSaved, deps), {
        wrapper: createTestProvider(),
      })
      await act(async () => result.current.connect())
      act(() => {
        void result.current.save()
      })
      if (action === 'disconnect') {
        await disconnectProviderConnection(getDb(), 'oauth:otari')
      } else if (action === 'unmount') {
        unmount()
      } else {
        act(() => result.current.cancel())
      }
      await act(async () => verification.resolve('supported'))
      expect(await getAllModels(getDb())).toEqual([])
      const credentials = await getProviderCredentials(getDb(), 'oauth:otari')
      if (action === 'disconnect') {
        expect(credentials).toBeNull()
      } else {
        expect(credentials?.access_token).toBe('key')
      }
      expect(useSearchProviderStore.getState().connectionId).toBe('oauth:otari')
      expect(onSaved).not.toHaveBeenCalled()
    },
  )

  it.each(['catalog', 'verification'] as const)(
    'rejects an old %s result when another window reconnects Otari to a different server',
    async (phase) => {
      const catalog = Promise.withResolvers<AvailableModel[]>()
      const catalogStarted = Promise.withResolvers<void>()
      const verification = Promise.withResolvers<'supported'>()
      spyOn(modelProbe, 'createDefaultProbe').mockReturnValue(() => verification.promise)
      const deps = {
        connect: mock(async () => 'old-key'),
        loadModels: mock(() => {
          catalogStarted.resolve()
          return phase === 'catalog' ? catalog.promise : Promise.resolve([{ id: 'old-model' }])
        }),
      }
      const onSaved = mock(() => {})
      const { result } = renderHook(() => useOtariConnectionState(onSaved, deps), { wrapper: createTestProvider() })
      let connecting: Promise<void>
      await act(async () => {
        connecting = result.current.connect()
        await catalogStarted.promise
        if (phase === 'verification') {
          await connecting
        }
      })
      if (phase === 'verification') {
        act(() => {
          void result.current.save()
        })
      }
      await saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Reconnected',
        authMethod: 'oauth',
        url: 'https://other.example.com/api/v1',
        credentials: { access_token: 'new-key' },
      })
      await act(async () => {
        catalog.resolve([{ id: 'old-model' }])
        verification.resolve('supported')
        await connecting
        await getClock().tickAsync(0)
      })
      expect(await getAllModels(getDb())).toEqual([])
      expect((await getProviderCredentials(getDb(), 'oauth:otari'))?.access_token).toBe('new-key')
      expect(result.current.error).toBe(
        phase === 'catalog'
          ? "Connected to Otari, but couldn't load your models. Please try again."
          : 'Could not verify or save the Otari model. Please try again.',
      )
      if (phase === 'catalog') {
        expect(result.current.modelsLoaded).toBe(false)
        expect(useSearchProviderStore.getState().connectionId).toBeNull()
      }
      expect(onSaved).not.toHaveBeenCalled()
    },
  )

  it('cancels a save queued after verification without removing the connected account', async () => {
    const queued = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const addModels = providerModels.addProviderModels
    spyOn(providerModels, 'addProviderModels').mockImplementationOnce(async (...args) => {
      queued.resolve()
      await proceed.promise
      return addModels(...args)
    })
    spyOn(modelProbe, 'createDefaultProbe').mockReturnValue(async () => 'supported')
    const deps = { connect: mock(async () => 'key'), loadModels: mock(async () => [{ id: 'model' }]) }
    const onSaved = mock(() => {})
    const { result } = renderHook(() => useOtariConnectionState(onSaved, deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connect())
    let saving: Promise<void>
    act(() => {
      saving = result.current.save()
    })
    await queued.promise
    act(() => result.current.cancel())
    await act(async () => {
      proceed.resolve()
      await saving
    })
    expect(await getAllModels(getDb())).toEqual([])
    expect((await getProviderCredentials(getDb(), 'oauth:otari'))?.access_token).toBe('key')
    expect(result.current.busy).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'disable', 'disconnect'] as const)(
    'does not select or report a model after %s immediately following its save',
    async (change) => {
      spyOn(modelProbe, 'createDefaultProbe').mockReturnValue(async () => 'supported')
      const deps = { connect: mock(async () => 'key'), loadModels: mock(async () => [{ id: 'model' }]) }
      const onSaved = mock(() => {})
      const { result } = renderHook(() => useOtariConnectionState(onSaved, deps), { wrapper: createTestProvider() })
      await act(async () => result.current.connect())
      const addModels = providerModels.addProviderModels
      spyOn(providerModels, 'addProviderModels').mockImplementationOnce(async (...args) => {
        const ids = await addModels(...args)
        if (change === 'cancel') {
          result.current.cancel()
        } else if (change === 'disable') {
          await updateProviderConnection(getDb(), 'oauth:otari', { enabled: false })
        } else {
          await disconnectProviderConnection(getDb(), 'oauth:otari')
        }
        return ids
      })
      await act(async () => result.current.save())
      expect(await getAllModels(getDb())).toHaveLength(1)
      expect((await getSettings(getDb(), { selected_model: '' })).selectedModel).toBe('')
      expect(onSaved).not.toHaveBeenCalled()
    },
  )

  it.each(['server', 'credentials'] as const)(
    'refuses a catalog refresh after the %s changes elsewhere',
    async (change) => {
      const deps = { connect: mock(async () => 'old-key'), loadModels: mock(async () => [{ id: 'model' }]) }
      const { result } = renderHook(() => useOtariConnectionState(undefined, deps), { wrapper: createTestProvider() })
      await act(async () => result.current.connect())
      await saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Reconnected',
        authMethod: 'oauth',
        url: change === 'server' ? 'https://other.example.com/api/v1' : 'https://api.otari.ai/api/v1',
        credentials: { access_token: change === 'credentials' ? 'new-key' : 'old-key' },
      })
      await act(async () => result.current.connect())
      expect(deps.loadModels).toHaveBeenCalledTimes(1)
      expect(result.current.error).toBe('Could not connect to Otari. Please try again.')
      expect(await getAllModels(getDb())).toEqual([])
    },
  )

  it('keeps the connection retryable when model verification fails without exposing provider errors', async () => {
    const probe = mock(async (): Promise<'unsupported'> => {
      throw new Error('secret-provider-details')
    })
    spyOn(modelProbe, 'createDefaultProbe').mockReturnValue(probe)
    const deps = { connect: mock(async () => 'key'), loadModels: mock(async () => [{ id: 'model' }]) }
    const onSaved = mock(() => {})
    const { result } = renderHook(() => useOtariConnectionState(onSaved, deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connect())
    await act(async () => result.current.save())
    expect(result.current.error).toBe('Could not verify or save the Otari model. Please try again.')
    expect(await getAllModels(getDb())).toEqual([])
    probe.mockResolvedValue('unsupported')
    await act(async () => result.current.save())
    expect((await getAllModels(getDb()))[0]).toMatchObject({ toolUsage: 0, providerConnectionId: 'oauth:otari' })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(result.current.key).toBe('')
    expect(result.current.searchStatus).toBeNull()
  })
})
