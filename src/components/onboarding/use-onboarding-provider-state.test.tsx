/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createModel, getAllModels, getAvailableModels, getModel, getSettings } from '@/dal'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getIntegrationCredentials, saveIntegrationCredentials } from '@/dal/integrations'
import { tinfoilAuth } from '@/lib/tinfoil-auth'
import { StrictMode, type ReactNode } from 'react'
import {
  cancelTinfoilMobileConnection,
  startTinfoilMobileConnection,
  captureTinfoilMobileReturn,
} from '@/lib/tinfoil-mobile-auth'
import { mobileOAuthRedirectUri } from '@/lib/oauth-redirect'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { getDb } from '@/db/database'
import { http } from '@/lib/http'
import * as platform from '@/lib/platform'
import type { OpenRouterConnectionOptions, OpenRouterManualConnection } from '@/lib/openrouter-auth'
import type { OnboardingProvider } from './provider-default-model'
import { defaultModelId, defaultModels } from '@shared/defaults/models'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { stubJsonResponse } from '@/test-utils/http'
import { createTestProvider } from '@/test-utils/test-provider'
import OnboardingModelStep from './onboarding-model-step'
import { useOnboardingProviderState } from './use-onboarding-provider-state'
import { useOnboardingModelState } from './use-onboarding-model-state'
import { rejectNestedTransactions } from '@/test-utils/flat-transactions'
import { getClock } from '@/testing-library'
import * as tinfoilSession from '@/lib/tinfoil-session'

type Dependencies = NonNullable<Parameters<typeof useOnboardingProviderState>[1]>

/** Fake only the external authorization boundaries; exercise the real add-model form. */
const makeDependencies = (overrides: Partial<Dependencies> = {}) => ({
  start: mock(async (_options?: OpenRouterConnectionOptions) => 'openrouter-key'),
  startTinfoil: mock(async (_options?: OpenRouterConnectionOptions) => ({
    access_token: 'tinfoil-oauth-key',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 900_000,
  })),
  startTinfoilMobile: mock(async (..._args: Parameters<typeof startTinfoilMobileConnection>) => {}),
  prepareManual: mock(
    async (): Promise<OpenRouterManualConnection> => ({
      authorizationUrl: 'https://openrouter.ai/auth?code_challenge=test',
      verifier: 'in-memory-verifier',
    }),
  ),
  exchange: mock(async (_code: string, _verifier: string, _signal?: AbortSignal) => 'manual-key'),
  needsManual: () => false,
  openUrl: mock(async (_url: string | URL) => {}),
  prepareModel: mock(async (provider: OnboardingProvider, apiKey: string) => {
    const preferred = defaultModels.find((model) => model.id === defaultModelId)!
    return {
      providerDefault: 1 as const,
      provider,
      apiKey,
      supportsTools: true,
      name: preferred.name,
      model: preferred.model,
      contextWindow: preferred.contextWindow,
      vendor: preferred.vendor,
      isConfidential: provider === 'tinfoil' ? 1 : 0,
      supportsParallelToolCalls: preferred.supportsParallelToolCalls,
      startWithReasoning: preferred.startWithReasoning,
    }
  }),
  ...overrides,
})

describe('useOnboardingProviderState', () => {
  const originalLocks = navigator.locks
  beforeAll(() => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, operation: () => Promise<unknown>) => operation() },
    })
  })
  afterAll(async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks })
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    // Standalone onboarding starts without seeded Cloud models, including the first randomized test.
    await resetTestDatabase()
    rejectNestedTransactions(getDb())
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true, serverHasAuthenticated: false, syncEnabled: false })
    spyOn(http, 'get').mockImplementation((url) =>
      stubJsonResponse({
        data: url.endsWith('/tools')
          ? [{ id: 'otari_web_search', available: true }]
          : [{ id: 'example/model', name: 'Example Model' }],
      }),
    )
  })

  afterEach(() => {
    cleanup()
    cancelTinfoilMobileConnection()
    mock.restore()
    resetStore()
    useSearchProviderStore.getState().clearSearchProvider()
  })

  it('saves and selects the verified default model after authorization without a picker', async () => {
    const deps = makeDependencies()
    const onConnected = mock(() => {})
    const { result } = renderHook(() => useOnboardingProviderState([], deps, onConnected), {
      wrapper: createTestProvider(),
    })
    expect(onConnected).not.toHaveBeenCalled()
    await act(async () => result.current.connectOpenRouter())
    expect(result.current.view).toBe('openrouter')
    expect(onConnected).not.toHaveBeenCalled()
    expect(result.current.isFormOpen).toBe(false)
    expect(result.current.isConnecting).toBe(false)
    expect(result.current.error).toBeNull()
    const models = await getAvailableModels(getDb())
    expect(models).toHaveLength(1)
    expect(models[0].apiKey).toBe('openrouter-key')
    expect(models[0].model).toBe(defaultModels.find((model) => model.id === defaultModelId)!.model)
    expect(models[0].isSystem).toBe(0)
    expect((await getSettings(getDb(), { selected_model: '' })).selectedModel).toBe(models[0].id)
    expect(result.current.addForm.form.getValues('apiKey')).toBe('')
  })

  it('aborts cancellation and ignores an authorization result arriving after the user changed their mind', async () => {
    const authorization = Promise.withResolvers<string>()
    const start = mock((_options?: OpenRouterConnectionOptions) => authorization.promise)
    const deps = makeDependencies({ start })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    act(() => {
      void result.current.connectOpenRouter()
    })
    await act(async () => {})
    expect(result.current.isConnecting).toBe(true)

    act(() => result.current.showChoices())
    expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true)
    await act(async () => authorization.resolve('late-key'))

    expect(result.current.view).toBe('choices')
    expect(result.current.addForm.form.getValues('apiKey')).toBe('')
    expect(result.current.error).toBeNull()
    expect(await getAvailableModels(getDb())).toEqual([])
  })

  it('discards the previous attempt when a newer connection wins', async () => {
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const start = mock((_options?: OpenRouterConnectionOptions) => first.promise)
    const deps = makeDependencies({ start })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    act(() => {
      void result.current.connectOpenRouter()
    })
    await act(async () => {})
    start.mockImplementation(() => second.promise)
    act(() => {
      void result.current.connectOpenRouter()
    })
    await act(async () => {})
    expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true)

    await act(async () => second.resolve('current-key'))
    await act(async () => first.resolve('obsolete-key'))

    expect(result.current.view).toBe('openrouter')
    expect((await getAvailableModels(getDb())).map((model) => model.apiKey)).toEqual(['current-key'])
  })

  it('aborts an in-progress browser authorization when the onboarding step unmounts', async () => {
    const authorization = Promise.withResolvers<string>()
    const start = mock((_options?: OpenRouterConnectionOptions) => authorization.promise)
    const { result, unmount } = renderHook(() => useOnboardingProviderState([], makeDependencies({ start })), {
      wrapper: createTestProvider(),
    })
    act(() => {
      void result.current.connectOpenRouter()
    })
    await act(async () => {})
    unmount()
    expect(start.mock.calls[0][0]?.signal?.aborted).toBe(true)
    await act(async () => authorization.reject(new Error('cancelled')))
  })

  it('opens the manual authorization page and exchanges its code using the matching in-memory verifier', async () => {
    const deps = makeDependencies({ needsManual: () => true })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connectOpenRouter())
    expect(deps.start).not.toHaveBeenCalled()
    expect(deps.openUrl).toHaveBeenCalledWith('https://openrouter.ai/auth?code_challenge=test')
    expect(result.current.view).toBe('manual')

    await act(async () => result.current.submitCode())
    expect(deps.exchange).not.toHaveBeenCalled()
    act(() => result.current.setCode('authorization-code'))
    await act(async () => result.current.submitCode())

    expect(deps.exchange).toHaveBeenCalledWith('authorization-code', 'in-memory-verifier', expect.any(AbortSignal))
    expect(result.current.view).toBe('openrouter')
    expect((await getAvailableModels(getDb()))[0].apiKey).toBe('manual-key')
    expect(result.current.manual).toBeNull()
    expect(result.current.code).toBe('')
  })

  it('does not open a late manual authorization page after cancellation', async () => {
    const preparation = Promise.withResolvers<OpenRouterManualConnection>()
    const deps = makeDependencies({ needsManual: () => true, prepareManual: () => preparation.promise })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    act(() => {
      void result.current.connectOpenRouter()
    })
    await act(async () => {})
    act(() => result.current.showChoices())
    await act(async () => preparation.resolve({ authorizationUrl: 'https://openrouter.ai/auth', verifier: 'late' }))

    expect(deps.openUrl).not.toHaveBeenCalled()
    expect(result.current.view).toBe('choices')
    expect(result.current.manual).toBeNull()
  })

  it('ignores a manual code exchange completed after cancellation', async () => {
    const exchange = Promise.withResolvers<string>()
    const exchangeCode = mock((_code: string, _verifier: string, _signal?: AbortSignal) => exchange.promise)
    const deps = makeDependencies({ needsManual: () => true, exchange: exchangeCode })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connectOpenRouter())
    act(() => result.current.setCode('code'))
    act(() => {
      void result.current.submitCode()
    })
    await act(async () => {})
    act(() => result.current.showChoices())
    expect(exchangeCode.mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => exchange.resolve('late-key'))

    expect(result.current.view).toBe('choices')
    expect(result.current.addForm.form.getValues('apiKey')).toBe('')
    expect(result.current.manual).toBeNull()
    expect(result.current.code).toBe('')
  })

  it('shows safe failure feedback and allows a manual OpenRouter API key fallback', async () => {
    const deps = makeDependencies({
      start: async () => {
        throw new Error('upstream secret')
      },
    })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connectOpenRouter())
    expect(result.current.error).toContain('use an API key')
    expect(result.current.error).not.toContain('upstream secret')
    expect(result.current.view).toBe('choices')
    expect(result.current.isConnecting).toBe(false)

    act(() => result.current.chooseProvider('openrouter'))
    expect(result.current.view).toBe('openrouter')
    expect(result.current.addForm.form.getValues('provider')).toBe('openrouter')
    expect(result.current.addForm.form.getValues('apiKey')).toBe('')
    expect(result.current.isFormOpen).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('keeps failed manual verification recoverable without discarding the matching verifier', async () => {
    const exchange = mock(async (_code: string, _verifier: string, _signal?: AbortSignal): Promise<string> => {
      throw new Error('invalid code')
    })
    const deps = makeDependencies({ needsManual: () => true, exchange })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connectOpenRouter())
    act(() => result.current.setCode('first-code'))
    await act(async () => result.current.submitCode())
    expect(result.current.view).toBe('manual')
    expect(result.current.error).toContain('Could not verify this code')
    expect(result.current.manual?.verifier).toBe('in-memory-verifier')

    exchange.mockImplementation(async () => 'retried-key')
    act(() => result.current.setCode('correct-code'))
    await act(async () => result.current.submitCode())
    expect(exchange.mock.calls[1][0]).toBe('correct-code')
    expect((await getAvailableModels(getDb()))[0].apiKey).toBe('retried-key')
    expect(result.current.error).toBeNull()
  })

  it('clears credentials when choosing Tinfoil or a local provider instead', async () => {
    const { result } = renderHook(() => useOnboardingProviderState([], makeDependencies()), {
      wrapper: createTestProvider(),
    })
    await act(async () => result.current.connectOpenRouter())
    act(() => result.current.chooseProvider('tinfoil'))
    expect(result.current.view).toBe('tinfoil')
    expect(result.current.addForm.form.getValues('provider')).toBe('tinfoil')
    expect(result.current.addForm.form.getValues('apiKey')).toBe('')
    expect(result.current.addForm.form.getValues('url')).toBe('')

    act(() => result.current.chooseProvider('custom'))
    expect(result.current.view).toBe('other')
    expect(result.current.addForm.form.getValues('provider')).toBe('custom')
    expect(result.current.addForm.form.getValues('url')).toBe('')
    expect(result.current.addForm.allowServerModels).toBe(false)
  })

  it('returns to provider choices for an existing connection and continues without reconnecting', async () => {
    const deps = makeDependencies()
    const { result, unmount } = renderHook(() => useOnboardingProviderState([], deps), {
      wrapper: createTestProvider(),
    })
    await act(async () => result.current.connectOpenRouter())
    unmount()
    const onContinue = mock(() => {})
    render(<OnboardingModelStep onContinue={onContinue} />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    expect(screen.getByRole('radio', { name: 'OpenRouter' })).toBeChecked()
    expect(screen.queryByText('Add another model')).not.toBeInTheDocument()
    expect(screen.queryByText(defaultModels.find((model) => model.id === defaultModelId)!.name)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed default connection unsaved and retries without another authorization', async () => {
    const prepareModel = makeDependencies().prepareModel
    const deps = makeDependencies({
      prepareModel: async () => {
        throw new Error('secret failure')
      },
    })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    await act(async () => result.current.connectOpenRouter())
    expect(await getAvailableModels(getDb())).toEqual([])
    expect(result.current.view).toBe('openrouter')
    expect(result.current.error).toContain('model verification request failed')
    expect(result.current.error).not.toContain('secret')
    deps.prepareModel = prepareModel
    await act(async () => result.current.connectApiKey())
    expect(deps.start).toHaveBeenCalledTimes(1)
    expect(result.current.view).toBe('openrouter')
    expect((await getAvailableModels(getDb()))[0].apiKey).toBe('openrouter-key')
  })

  it('does not save a late default-model verification after cancellation', async () => {
    const preparation = Promise.withResolvers<Awaited<ReturnType<Dependencies['prepareModel']>>>()
    const deps = makeDependencies({ prepareModel: () => preparation.promise })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    act(() => {
      void result.current.connectOpenRouter()
    })
    await act(async () => {})
    act(() => result.current.showChoices())
    const prepared = await makeDependencies().prepareModel(
      'openrouter',
      'discarded',
      () => {
        throw new Error('Unexpected network')
      },
      new AbortController().signal,
    )
    await act(async () => preparation.resolve(prepared))
    expect(result.current.view).toBe('choices')
    expect(await getAvailableModels(getDb())).toEqual([])
  })

  it('does not save OAuth credentials when cancelled while waiting for the session lock', async () => {
    const lockEntered = Promise.withResolvers<void>()
    const releaseLock = Promise.withResolvers<void>()
    spyOn(tinfoilSession, 'withTinfoilSessionLock').mockImplementation(async (operation) => {
      lockEntered.resolve()
      await releaseLock.promise
      return operation()
    })
    const deps = makeDependencies()
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    let connection!: Promise<void>
    await act(async () => {
      connection = result.current.connectTinfoil()
      await lockEntered.promise
    })
    act(() => result.current.cancelConnection())
    await act(async () => {
      releaseLock.resolve()
      await connection
    })
    expect(await getAvailableModels(getDb())).toEqual([])
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.addForm.submitError).toBeNull()
  })

  it.each([true, false])(
    'does not restore a disconnected session from a pending OAuth attempt (existing session: %s)',
    async (existingSession) => {
      const original = { access_token: 'original-token', expires_at: Date.now() + 900_000 }
      if (existingSession) {
        await saveIntegrationCredentials(getDb(), 'tinfoil', original, true)
      }
      const probeStarted = Promise.withResolvers<void>()
      const releaseProbe = Promise.withResolvers<void>()
      const prepareModel = makeDependencies().prepareModel
      const deps = makeDependencies({
        prepareModel: async (...args) => {
          probeStarted.resolve()
          await releaseProbe.promise
          return prepareModel(...args)
        },
      })
      const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
      let connection!: Promise<void>
      await act(async () => {
        connection = result.current.connectTinfoil()
        await probeStarted.promise
      })
      // A second window completes a connection and disconnects while this window is still probing.
      if (!existingSession) {
        const second = renderHook(() => useOnboardingProviderState([], makeDependencies()), {
          wrapper: createTestProvider(),
        })
        await act(async () => second.result.current.connectTinfoil())
        second.unmount()
      }
      const session = tinfoilSession.createTinfoilSession({
        db: getDb,
        auth: { ...tinfoilAuth, revoke: mock(async () => {}) },
        lock: async (operation) => operation(),
        now: Date.now,
      })
      await session.disconnect()
      const disconnected = await getIntegrationCredentials(getDb(), 'tinfoil')
      await act(async () => {
        releaseProbe.resolve()
        await connection
      })
      expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual(disconnected)
      expect(await getAvailableModels(getDb())).toEqual([])
      expect(result.current.error).toContain('Could not save')

      // Retrying starts a new authorization; it must not adopt the old grant after the disconnect.
      await act(async () => result.current.connectTinfoil())
      expect(deps.startTinfoil).toHaveBeenCalledTimes(2)
      expect(await getAvailableModels(getDb())).toHaveLength(1)
    },
  )

  it('does not verify a late OAuth grant after another window disconnects', async () => {
    const authorizationStarted = Promise.withResolvers<void>()
    const authorization = Promise.withResolvers<Awaited<ReturnType<Dependencies['startTinfoil']>>>()
    const deps = makeDependencies({
      startTinfoil: () => {
        authorizationStarted.resolve()
        return authorization.promise
      },
    })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    let connection!: Promise<void>
    await act(async () => {
      connection = result.current.connectTinfoil()
      await authorizationStarted.promise
    })
    const session = tinfoilSession.createTinfoilSession({
      db: getDb,
      auth: { ...tinfoilAuth, revoke: mock(async () => {}) },
      lock: async (operation) => operation(),
      now: Date.now,
    })
    await session.disconnect()
    const disconnected = await getIntegrationCredentials(getDb(), 'tinfoil')
    await act(async () => {
      authorization.resolve({ access_token: 'late-token', expires_at: Date.now() + 900_000 })
      await connection
    })
    expect(deps.prepareModel).not.toHaveBeenCalled()
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toEqual(disconnected)
    expect(await getAvailableModels(getDb())).toEqual([])
  })

  it.each([true, false])(
    'does not restore OpenRouter after a connect/disconnect cycle in another window (existing row: %s)',
    async (existingRow) => {
      const second = renderHook(
        () => ({
          setup: useOnboardingProviderState([], makeDependencies()),
          models: useOnboardingModelState(),
        }),
        { wrapper: createTestProvider() },
      )
      if (existingRow) {
        await act(async () => second.result.current.setup.connectOpenRouter())
        await act(async () => second.result.current.models.disconnectProvider('openrouter'))
      }
      const probeStarted = Promise.withResolvers<void>()
      const releaseProbe = Promise.withResolvers<void>()
      const prepareModel = makeDependencies().prepareModel
      const deps = makeDependencies({
        prepareModel: async (...args) => {
          probeStarted.resolve()
          await releaseProbe.promise
          return prepareModel(...args)
        },
      })
      const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
      let connection!: Promise<void>
      await act(async () => {
        connection = result.current.connectOpenRouter()
        await probeStarted.promise
      })
      await act(async () => second.result.current.setup.connectOpenRouter())
      await act(async () => second.result.current.models.disconnectProvider('openrouter'))
      const disconnected = await getAllModels(getDb())
      expect(disconnected).toHaveLength(1)
      expect(disconnected[0].apiKey).toBeNull()
      await act(async () => {
        releaseProbe.resolve()
        await connection
      })
      expect(await getAllModels(getDb())).toEqual(disconnected)
      expect(result.current.error).toContain('Could not save')
      // The metadata row does not hold a key or advertise an OAuth integration.
      expect(await getIntegrationCredentials(getDb(), 'openrouter')).toEqual({
        enabled: false,
        credentials: { access_token: '', sessionRevision: expect.any(String) },
      })
      await act(async () => result.current.connectOpenRouter())
      expect(deps.start).toHaveBeenCalledTimes(2)
      expect((await getAllModels(getDb()))[0].apiKey).toBe('openrouter-key')
    },
  )

  it('saves Tinfoil with its default model and confidential transport metadata', async () => {
    const deps = makeDependencies()
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    act(() => result.current.chooseProvider('tinfoil'))
    act(() => result.current.addForm.form.setValue('apiKey', 'tinfoil-key'))
    await act(async () => result.current.connectApiKey())
    expect(result.current.view).toBe('tinfoil')
    const model = (await getAvailableModels(getDb()))[0]
    expect(model.provider).toBe('tinfoil')
    expect(model.apiKey).toBe('tinfoil-key')
    expect(model.isConfidential).toBe(1)
    expect(model.contextWindow).toBe(defaultModels.find((model) => model.id === defaultModelId)!.contextWindow)
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('shows Tinfoil key setup and the local-provider form from their onboarding choices', async () => {
    render(<OnboardingModelStep />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    expect(screen.getByRole('radio', { name: 'OpenRouter' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Tinfoil' }))
    expect(screen.getByRole('radio', { name: 'Tinfoil' })).toBeChecked()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Connect Tinfoil' })).toBeInTheDocument()
    expect(screen.queryByText('Connect with a paid Tinfoil subscription.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }))
    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Other provider' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByLabelText('URL')).toHaveValue('')
    expect(screen.getByLabelText('API Key (Optional)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Model' })).toBeDisabled()
  })

  it('starts native-mobile Tinfoil authorization while retaining OpenRouter code authorization and optional keys', async () => {
    const deps = makeDependencies({ needsManual: () => true })
    const { result } = renderHook(() => useOnboardingProviderState([], deps), { wrapper: createTestProvider() })
    act(() => result.current.chooseProvider('tinfoil'))
    expect(result.current.showApiKey).toBe(false)
    await act(async () => result.current.connectTinfoil())
    expect(deps.startTinfoilMobile).toHaveBeenCalledTimes(1)
    act(() => result.current.cancelConnection())
    act(() => result.current.useApiKey())
    act(() => result.current.addForm.form.setValue('apiKey', 'mobile-key'))
    await act(async () => result.current.connectApiKey())
    expect(deps.startTinfoil).not.toHaveBeenCalled()
    expect((await getAvailableModels(getDb()))[0]).toMatchObject({
      provider: 'tinfoil',
      apiKey: 'mobile-key',
      oauthProvider: null,
    })
    act(() => result.current.chooseProvider('openrouter'))
    expect(result.current.showApiKey).toBe(false)
    await act(async () => result.current.connectOpenRouter())
    expect(result.current.view).toBe('manual')
  })

  it('offers native-mobile Tinfoil sign-in and lets Back return to choices', async () => {
    spyOn(platform, 'isTauri').mockReturnValue(true)
    spyOn(platform, 'isMobile').mockReturnValue(true)
    render(<OnboardingModelStep />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    fireEvent.click(screen.getByRole('radio', { name: 'Tinfoil' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Tinfoil' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use sign-in instead' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('radio', { name: 'Tinfoil' })).toBeInTheDocument()
  })

  it.each([false, true])('resumes native authorization once after remount (StrictMode: %s)', async (strict) => {
    const nonce = 'n'.repeat(43)
    const attempt = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    const exchange = mock(async () => ({
      access_token: 'mobile-access',
      refresh_token: 'mobile-refresh',
      expires_at: Date.now() + 900_000,
    }))
    await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, {
      verifier: () => nonce,
      challenge: async () => 'challenge',
      openUrl: async () => {},
    })
    captureTinfoilMobileReturn(new URL(`${mobileOAuthRedirectUri}?code=code&state=${nonce}`), { exchange })
    const deps = makeDependencies()
    const TestProvider = createTestProvider()
    const { result } = renderHook(() => useOnboardingProviderState([], deps), {
      wrapper: strict
        ? ({ children }: { children: ReactNode }) => (
            <StrictMode>
              <TestProvider>{children}</TestProvider>
            </StrictMode>
          )
        : TestProvider,
    })
    await act(async () => getClock().runAllAsync())
    expect(result.current.view).toBe('tinfoil')
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(deps.startTinfoil).not.toHaveBeenCalled()
    expect((await getAvailableModels(getDb()))[0]).toMatchObject({
      provider: 'tinfoil',
      oauthProvider: 'tinfoil',
      apiKey: null,
    })
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.access_token).toBe('mobile-access')
  })

  it('aborts a returning mobile exchange when the user goes back and ignores its late result', async () => {
    const nonce = 'n'.repeat(43)
    const attempt = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    const completion = Promise.withResolvers<{ access_token: string; expires_at: number }>()
    const exchange = mock((_params: unknown, _signal?: AbortSignal) => completion.promise)
    await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, {
      verifier: () => nonce,
      challenge: async () => 'challenge',
      openUrl: async () => {},
    })
    captureTinfoilMobileReturn(new URL(`${mobileOAuthRedirectUri}?code=code&state=${nonce}`), { exchange })
    const { result } = renderHook(() => useOnboardingProviderState([], makeDependencies()), {
      wrapper: createTestProvider(),
    })
    await act(async () => {})
    expect(exchange).toHaveBeenCalledTimes(1)
    act(() => result.current.showChoices())
    expect(exchange.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => completion.resolve({ access_token: 'late-key', expires_at: Date.now() + 900_000 }))
    expect(result.current.view).toBe('choices')
    expect(await getAvailableModels(getDb())).toHaveLength(0)
    expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toBeNull()
  })

  it('refuses a mobile callback if another window disconnected before it returned', async () => {
    const nonce = 'n'.repeat(43)
    const attempt = await getProviderConnectionAttempt(getDb(), 'tinfoil')
    const exchange = mock(async () => ({ access_token: 'must-not-save', expires_at: Date.now() + 900_000 }))
    await startTinfoilMobileConnection('onboarding', attempt, new AbortController().signal, {
      verifier: () => nonce,
      challenge: async () => 'challenge',
      openUrl: async () => {},
    })
    captureTinfoilMobileReturn(new URL(`${mobileOAuthRedirectUri}?code=code&state=${nonce}`), { exchange })
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: '', sessionRevision: 'disconnected' }, false)
    const { result } = renderHook(() => useOnboardingProviderState([], makeDependencies()), {
      wrapper: createTestProvider(),
    })
    await act(async () => getClock().runAllAsync())
    expect(exchange).not.toHaveBeenCalled()
    expect(result.current.error).toContain('Could not connect')
    expect(await getAvailableModels(getDb())).toHaveLength(0)
  })

  it('starts Tinfoil authorization only after its connection button and stays on that screen after saving', async () => {
    const deps = makeDependencies()
    const onContinue = mock(() => {})
    const { result } = renderHook(() => useOnboardingProviderState([], deps, onContinue), {
      wrapper: createTestProvider(),
    })
    act(() => result.current.selectProvider('tinfoil'))
    act(() => result.current.continueSelection())
    expect(result.current.view).toBe('tinfoil')
    expect(deps.startTinfoil).not.toHaveBeenCalled()
    await act(async () => result.current.connectSelectedProvider())
    expect(deps.startTinfoil).toHaveBeenCalledTimes(1)
    expect(deps.start).not.toHaveBeenCalled()
    expect(result.current.view).toBe('tinfoil')
    const connectedModel = (await getAvailableModels(getDb()))[0]
    expect(connectedModel).toMatchObject({ apiKey: null, oauthProvider: 'tinfoil' })
    expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials).toMatchObject({
      access_token: 'tinfoil-oauth-key',
      refresh_token: 'refresh-token',
    })
    await act(async () => result.current.connectTinfoil())
    const reconnected = await getAvailableModels(getDb())
    expect(reconnected).toHaveLength(1)
    expect(reconnected[0].id).toBe(connectedModel.id)
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('disconnects the selected provider without deleting models, history, or another provider connection', async () => {
    const { result, unmount } = renderHook(() => useOnboardingProviderState([], makeDependencies()), {
      wrapper: createTestProvider(),
    })
    await act(async () => result.current.connectOpenRouter())
    act(() => result.current.chooseProvider('tinfoil'))
    await act(async () => result.current.connectSelectedProvider())
    const models = await getAvailableModels(getDb())
    const openrouter = models.find((model) => model.provider === 'openrouter')!
    const tinfoil = models.find((model) => model.provider === 'tinfoil')!
    await createModel(getDb(), {
      id: 'manual-openrouter',
      name: 'Manual',
      provider: 'openrouter',
      model: 'other',
      apiKey: 'own-key',
      enabled: 1,
    })
    unmount()
    render(<OnboardingModelStep />, { wrapper: createTestProvider() })
    await act(async () => getClock().runAllAsync())
    fireEvent.click(screen.getByRole('radio', { name: 'OpenRouter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Connected')).toBeInTheDocument()
    const disconnect = screen.getByRole('button', { name: 'Disconnect' })
    fireEvent.mouseEnter(disconnect)
    expect(disconnect).toHaveTextContent('Disconnect')
    await act(async () => {
      fireEvent.click(disconnect)
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('button', { name: 'Connect OpenRouter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    const disconnected = await getModel(getDb(), openrouter.id)
    expect(await getModel(getDb(), 'manual-openrouter')).toMatchObject({
      apiKey: 'own-key',
      enabled: 1,
      deletedAt: null,
    })
    expect(disconnected?.apiKey).toBeNull()
    expect(disconnected?.enabled).toBe(1)
    expect(disconnected?.deletedAt).toBeNull()
    expect((await getModel(getDb(), tinfoil.id))?.oauthProvider).toBe('tinfoil')
  })
})
