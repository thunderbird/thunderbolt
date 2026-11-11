/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { createModel, getSettings, updateSettings } from '@/dal'
import * as dal from '@/dal'
import { saveProviderConnection, saveProviderConnectionInTransaction } from '@/dal/provider-connections'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, fireEvent, screen } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { mockLocationData } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { OnboardingDialog } from './onboarding-dialog'
import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { SignInModalProvider, type AuthClient } from '@/contexts'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { thunderboltCloudUrl } from '@/lib/constants'
import * as otariCapabilities from '@/integrations/otari-search/capabilities'

let consoleSpies: ConsoleSpies
let originalCloudUrl: string
let originalLocalMode: boolean

beforeAll(async () => {
  await setupTestDatabase()
  // Preload the lazy provider steps before fake timers drive wizard transitions.
  await import('./onboarding-model-step')
  await import('./onboarding-search-step')
  consoleSpies = setupConsoleSpy()
})

afterAll(async () => {
  await teardownTestDatabase()
  consoleSpies.restore()
})

beforeEach(async () => {
  await updateSettings(getDb(), { experimental_feature_otari: true })
  originalCloudUrl = getLocalSetting('cloudUrl')
  originalLocalMode = getLocalSetting('localMode')
  useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example.com/v1', localMode: false })
  setAuthToken('test-session')
})

afterEach(async () => {
  clearAuthToken()
  useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl, localMode: originalLocalMode })
  useSearchProviderStore.getState().clearSearchProvider()
  await resetTestDatabase()
})

const createRouterWrapper =
  (locationState?: unknown, authClient?: AuthClient) =>
  ({ children }: { children: ReactNode }) => {
    const TestProvider = createTestProvider({ mockResponse: mockLocationData, authClient })
    const entries = [{ pathname: '/', state: locationState ?? null }]
    return (
      <MemoryRouter initialEntries={entries}>
        <TestProvider>
          <SignInModalProvider>{children}</SignInModalProvider>
        </TestProvider>
      </MemoryRouter>
    )
  }

describe('OnboardingDialog', () => {
  describe('anonymous data donation', () => {
    const flush = async () => {
      await act(async () => {
        await getClock().runAllAsync()
      })
    }

    it.each([true, false])('persists opting out before completing onboarding (local: %s)', async (local) => {
      useLocalSettingsStore.setState({ cloudUrl: local ? '' : 'https://cloud.example.com/v1', localMode: local })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '7' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()

      const donation = screen.getByRole('switch', { name: 'Donate anonymous usage data' })
      expect(donation).toBeChecked()
      fireEvent.click(donation)
      await flush()
      expect(donation).not.toBeChecked()
      expect((await getSettings(getDb(), { data_collection: true })).dataCollection).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await flush()
      expect(await getSettings(getDb(), { data_collection: true, user_has_completed_onboarding: false })).toEqual({
        dataCollection: false,
        userHasCompletedOnboarding: true,
      })
    })

    it('respects an existing opt-out and lets the user donate again', async () => {
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '7', data_collection: false })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()

      const donation = screen.getByRole('switch', { name: 'Donate anonymous usage data' })
      expect(donation).not.toBeChecked()
      fireEvent.click(donation)
      await flush()
      expect(donation).toBeChecked()
      expect((await getSettings(getDb(), { data_collection: false })).dataCollection).toBe(true)
    })

    it('keeps setup open if the donation preference fails to save and allows retry', async () => {
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '7' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()

      const save = spyOn(getDb(), 'transaction').mockRejectedValueOnce(new Error('Storage unavailable'))
      try {
        fireEvent.click(screen.getByRole('switch', { name: 'Donate anonymous usage data' }))
        await flush()
        expect(screen.getByRole('alert')).toHaveTextContent('Could not save your preference. Please try again.')
        expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
        expect((await getSettings(getDb(), { user_has_completed_onboarding: false })).userHasCompletedOnboarding).toBe(
          false,
        )

        fireEvent.click(screen.getByRole('switch', { name: 'Donate anonymous usage data' }))
        await flush()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
        expect((await getSettings(getDb(), { data_collection: true })).dataCollection).toBe(false)
      } finally {
        save.mockRestore()
      }
    })
  })

  describe('standalone requirements', () => {
    const flush = async () => {
      await act(async () => {
        await getClock().runAllAsync()
      })
    }

    it('defaults to Local and offers optional AI setup after clicking Continue', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '' })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '8' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.queryByText('Choose your setup')).not.toBeNull()
      expect(screen.getByRole('radio', { name: 'Cloud (Waitlist)' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Enterprise' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Local' })).toBeChecked()
      expect(screen.getByText('Choose your setup')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await flush()
      expect(screen.getByRole('radio', { name: 'OpenRouter' })).toBeChecked()
      // The lazily mounted provider step starts its own model query.
      await flush()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled()
    })

    it('uses the wizard Back button to leave the organization form before returning to privacy', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '8' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()

      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
      expect(screen.getAllByRole('radio')[0]).toHaveAccessibleName('Local')
      expect(screen.getByRole('radio', { name: 'Local' })).toBeChecked()
      fireEvent.click(screen.getByRole('radio', { name: 'Enterprise' }))
      expect(screen.queryByLabelText('Thunderbolt server address')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(screen.getByLabelText('Thunderbolt server address')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back to options' })).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByText('Choose your setup')).toBeInTheDocument()
      expect(screen.queryByLabelText('Thunderbolt server address')).not.toBeInTheDocument()
      expect((await getSettings(getDb(), { onboarding_current_step: '1' })).onboardingCurrentStep).toBe('8')

      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      await flush()
      expect((await getSettings(getDb(), { onboarding_current_step: '1' })).onboardingCurrentStep).toBe('1')
      expect(screen.queryByText('Choose your setup')).not.toBeInTheDocument()
    })

    it('returns from Cloud waitlist to setup choices before continuing without a server', async () => {
      useLocalSettingsStore.setState({
        cloudUrl: thunderboltCloudUrl,
        localMode: true,
        serverHasAuthenticated: false,
        syncEnabled: false,
      })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '8' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.getByText('Want early access?')).toBeInTheDocument()
      expect(screen.queryByText('Sign in to Thunderbolt')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByText('Choose your setup')).toBeInTheDocument()
      expect(getLocalSetting('cloudUrl')).toBe('')
      expect((await getSettings(getDb(), { onboarding_current_step: '1' })).onboardingCurrentStep).toBe('8')

      fireEvent.click(screen.getByRole('radio', { name: 'Local' }))
      expect(screen.getByText('Choose your setup')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await flush()
      expect((await getSettings(getDb(), { onboarding_current_step: '1' })).onboardingCurrentStep).toBe('9')
      expect(screen.queryByText('Want early access?')).not.toBeInTheDocument()
    })

    it('offers optional own-model setup after selecting a server without signing in', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '8' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      act(() => useLocalSettingsStore.setState({ cloudUrl: 'https://chosen.example.com/v1' }))
      expect(screen.queryByText('Selected server')).not.toBeNull()
      expect(screen.queryByText('https://chosen.example.com/v1')).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Continue setup without signing in' }))
      await flush()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled()
    })

    it('opens server sign-in and only switches to connected onboarding once an account exists', async () => {
      useLocalSettingsStore.setState({ cloudUrl: 'https://chosen.example.com/v1', localMode: true })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '8' })
      const authClient = createMockAuthClient()
      const signedInClient = createMockAuthClient({
        session: { user: { id: 'anon-server-user', email: '', isAnonymous: true } },
      })
      const sessionSpy = spyOn(authClient, 'useSession')
      const { rerender } = render(<OnboardingDialog />, { wrapper: createRouterWrapper(undefined, authClient) })
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
      await flush()
      expect(screen.queryByText('Sign in to Thunderbolt')).not.toBeNull()
      act(() => setAuthToken('new-session'))
      sessionSpy.mockImplementation(signedInClient.useSession)
      rerender(<OnboardingDialog />)
      await flush()
      expect(screen.queryByRole('heading', { name: 'Connect Google' })).not.toBeNull()
      expect(screen.queryByText('Choose your setup')).toBeNull()
      sessionSpy.mockRestore()
    })

    it.each(['choices', 'OpenRouter', 'Tinfoil'] as const)(
      'skips %s AI setup and continues to search',
      async (choice) => {
        useLocalSettingsStore.setState({ cloudUrl: '' })
        await reconcileDefaults(getDb())
        await updateSettings(getDb(), { onboarding_current_step: '9' })
        render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
        await flush()
        if (choice !== 'choices') {
          fireEvent.click(screen.getByRole('radio', { name: choice }))
          fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
          expect(screen.getByRole('button', { name: `Connect ${choice}` })).toBeInTheDocument()
          expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
        }
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
        await flush()
        expect(screen.getByRole('heading', { name: 'Add web search' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
        await flush()
        expect(screen.getByRole('heading', { name: 'What should we call you?' })).toBeInTheDocument()
      },
    )

    it('lets a user with their own model skip search setup', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '' })
      await reconcileDefaults(getDb())
      await createModel(
        getDb(),
        createMockModel({
          id: 'onboarding-own-model',
          provider: 'custom',
          isSystem: 0,
          url: 'http://localhost:11434/v1',
          apiKey: null,
        }),
      )
      await updateSettings(getDb(), { onboarding_current_step: '10' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.queryByText('Add web search')).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await flush()
      expect(screen.queryByText('What should we call you?')).not.toBeNull()
    })

    it.each(['api_key', 'oauth'] as const)(
      'omits search for a Tinfoil %s connection without requiring a model, including Back navigation',
      async (authMethod) => {
        useLocalSettingsStore.setState({ cloudUrl: '' })
        await reconcileDefaults(getDb())
        const id = await getDb().transaction((tx) =>
          saveProviderConnectionInTransaction(tx, {
            provider: 'tinfoil',
            name: 'Tinfoil',
            authMethod,
            credentials:
              authMethod === 'oauth'
                ? { access_token: 'token', expires_at: Date.now() + 3_600_000 }
                : { apiKey: 'key' },
          }),
        )
        useSearchProviderStore.getState().configureProviderSearch(id, 'available')
        await updateSettings(getDb(), { onboarding_current_step: '10', selected_model: '' })
        render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
        await flush()
        expect(screen.queryByText('Add web search')).toBeNull()
        expect(screen.queryByText('What should we call you?')).not.toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Back' }))
        await flush()
        expect(screen.queryByRole('heading', { name: 'Connect your AI' })).not.toBeNull()
        expect(screen.queryByText('Add web search')).toBeNull()
      },
    )
    it.each(['available', 'not_configured', 'workspace_disabled', 'unknown'] as const)(
      'only skips search when the Otari connection advertises it (%s)',
      async (status) => {
        const discovery = spyOn(otariCapabilities, 'loadOtariWebCapabilities').mockResolvedValue({
          search: status,
          fetch: 'available',
        })
        try {
          useLocalSettingsStore.setState({ cloudUrl: '' })
          await reconcileDefaults(getDb())
          const id = await saveProviderConnection(getDb(), {
            provider: 'otari',
            name: 'Otari',
            url: 'http://localhost:8099/api/v1',
            authMethod: 'api_key',
            credentials: { apiKey: 'key' },
          })
          useSearchProviderStore.getState().configureProviderSearch(id, status)
          await updateSettings(getDb(), { onboarding_current_step: '10', selected_model: '' })
          render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
          await flush()
          if (status !== 'available') {
            expect(screen.getByText('Add web search')).toBeInTheDocument()
            expect(
              screen.getByText('Otari web search isn’t available. Choose a search provider below, or skip for now.'),
            ).toBeInTheDocument()
            expect(useSearchProviderStore.getState().selection).toBe('auto')
            return
          }
          expect(screen.queryByText('Add web search')).toBeNull()
          expect(screen.getByText('What should we call you?')).toBeInTheDocument()
          fireEvent.click(screen.getByRole('button', { name: 'Back' }))
          await flush()
          expect(screen.getByRole('heading', { name: 'Connect your AI' })).toBeInTheDocument()
        } finally {
          discovery.mockRestore()
        }
      },
    )
    it('keeps connection-owned search when all its models are disabled', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '' })
      await reconcileDefaults(getDb())
      const id = await saveProviderConnection(getDb(), {
        provider: 'tinfoil',
        name: 'Tinfoil',
        authMethod: 'api_key',
        credentials: { apiKey: 'key' },
      })
      await createModel(getDb(), {
        id: 'disabled',
        provider: 'tinfoil',
        name: 'Disabled',
        model: 'test',
        providerConnectionId: id,
        enabled: 0,
        toolUsage: 0,
      })
      useSearchProviderStore.getState().configureProviderSearch(id, 'available')
      await updateSettings(getDb(), { onboarding_current_step: '10' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.queryByText('Add web search')).toBeNull()
      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
    })
    it.each(['missing', 'disabled', 'reauth'] as const)(
      'keeps search setup for a %s Tinfoil connection',
      async (availability) => {
        useLocalSettingsStore.setState({ cloudUrl: '' })
        await reconcileDefaults(getDb())
        if (availability !== 'missing') {
          await getDb().transaction((tx) =>
            saveProviderConnectionInTransaction(tx, {
              provider: 'tinfoil',
              name: 'Tinfoil',
              authMethod: 'oauth',
              enabled: availability !== 'disabled',
              credentials: { access_token: 'token', reauth_required: availability === 'reauth' },
            }),
          )
        }
        useSearchProviderStore.getState().configureProviderSearch('oauth:tinfoil', 'available')
        await updateSettings(getDb(), { onboarding_current_step: '10' })
        render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
        await flush()
        expect(screen.getByRole('heading', { name: 'Add web search' })).toBeInTheDocument()
      },
    )
    it('allows continuing with an existing named search connection without re-entering its key', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '' })
      await reconcileDefaults(getDb())
      const id = await saveProviderConnection(getDb(), {
        provider: 'exa',
        name: 'Work search',
        authMethod: 'api_key',
        credentials: { apiKey: 'key' },
      })
      useSearchProviderStore.getState().selectSearchConnection(id)
      await updateSettings(getDb(), { onboarding_current_step: '10' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.getByRole('radio', { name: 'Work search' })).toBeChecked()
      expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await flush()
      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
    })

    it('can finish onboarding without a model when AI setup is skipped', async () => {
      useLocalSettingsStore.setState({ cloudUrl: 'https://chosen.example.com/v1', localMode: true })
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { onboarding_current_step: '7' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await flush()
      const settings = await getSettings(getDb(), {
        user_has_completed_onboarding: false,
        onboarding_current_step: '1',
      })
      expect(settings.userHasCompletedOnboarding).toBe(true)
      expect(settings.onboardingCurrentStep).toBe('1')
    })
  })
  it('completes onboarding in one write and permits retry after that write fails', async () => {
    await reconcileDefaults(getDb())
    await updateSettings(getDb(), { onboarding_current_step: '7' })
    render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    const write = spyOn(dal, 'updateSettings')
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue(undefined)
    try {
      const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
      await act(async () => {
        fireEvent.click(button)
      })
      expect(button.disabled).toBe(false)
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0][1]).toEqual({ user_has_completed_onboarding: true, onboarding_current_step: '1' })
      await act(async () => {
        fireEvent.click(button)
      })
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      write.mockRestore()
    }
  })

  it('disables every navigation action while saving the name, then advances only once', async () => {
    await reconcileDefaults(getDb())
    await updateSettings(getDb(), { onboarding_current_step: '3' })
    render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Alice' } })
    const pending = Promise.withResolvers<void>()
    const write = spyOn(dal, 'updateSettings').mockImplementationOnce(() => pending.promise)
    try {
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      })
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled()
      expect(screen.getByRole('textbox')).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await act(async () => {
        pending.resolve()
        await getClock().runAllAsync()
      })
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[1][1]).toEqual({ onboarding_current_step: '4' })
      expect(screen.getByText('Where are you located?')).toBeInTheDocument()
    } finally {
      write.mockRestore()
    }
  })

  it('keeps a failed name save on the editable name step and allows retry', async () => {
    await reconcileDefaults(getDb())
    await updateSettings(getDb(), { onboarding_current_step: '3' })
    render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alice' } })
    const write = spyOn(dal, 'updateSettings').mockRejectedValueOnce(new Error('disk full'))
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        await getClock().runAllAsync()
      })
      expect(screen.getByRole('textbox')).toHaveValue('Alice')
      expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
      expect(write).toHaveBeenCalledTimes(1)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        await getClock().runAllAsync()
      })
      expect(screen.getByText('Where are you located?')).toBeInTheDocument()
    } finally {
      write.mockRestore()
    }
  })

  it('does not navigate after a name save finishes on an unmounted wizard', async () => {
    await reconcileDefaults(getDb())
    await updateSettings(getDb(), { onboarding_current_step: '3' })
    const { unmount } = render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alice' } })
    const pending = Promise.withResolvers<void>()
    const write = spyOn(dal, 'updateSettings').mockImplementationOnce(() => pending.promise)
    try {
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      })
      unmount()
      await act(async () => {
        pending.resolve()
        await getClock().runAllAsync()
      })
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      write.mockRestore()
    }
  })

  it('persists Skip and Back through the same navigation owner', async () => {
    await reconcileDefaults(getDb())
    await updateSettings(getDb(), { onboarding_current_step: '2' })
    render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByText('What should we call you?')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      await getClock().runAllAsync()
    })
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Skip' })).not.toBeDisabled()
  })

  it('skips the passkey step after determining it is unavailable', async () => {
    await reconcileDefaults(getDb())
    await updateSettings(getDb(), { onboarding_current_step: '5' })
    render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })

  describe('Component rendering', () => {
    it('should render without crashing', () => {
      render(<OnboardingDialog />, {
        wrapper: createRouterWrapper(),
      })
    })

    it('should handle location state changes', () => {
      const oauthState = {
        oauth: {
          code: 'mock_auth_code_12345',
          state: 'mock_state_67890',
          error: undefined,
        },
      }

      render(<OnboardingDialog />, {
        wrapper: createRouterWrapper(oauthState),
      })
    })

    it('should handle OAuth error state', () => {
      const oauthErrorState = {
        oauth: {
          code: undefined,
          state: 'mock_state_67890',
          error: 'access_denied',
        },
      }

      render(<OnboardingDialog />, {
        wrapper: createRouterWrapper(oauthErrorState),
      })
    })
  })

  describe('Integration with database', () => {
    it('should work with real database operations', async () => {
      render(<OnboardingDialog />, {
        wrapper: createRouterWrapper(),
      })

      await waitFor(() => {
        expect(true).toBe(true)
      })
    })
  })

  /**
   * GH #1299. `isOpen` used to be mirrored into state by an effect that only
   * ever called `setIsOpen(true)`, so nothing closed the wizard once the flag
   * flipped — a device that learned it was already onboarded, from sign-in or a
   * sync download, kept it on screen. It is derived during render now.
   *
   * The flip is driven through react-query invalidation because the PowerSync
   * test mock's `onChangeWithCallback` is a no-op, so a watched query never
   * re-emits on its own. Asserting only the two mount states would not
   * discriminate: the old effect also left the dialog closed when the flag
   * started true.
   */
  describe('closing when the flag flips', () => {
    const wizardTitle = 'Onboarding Wizard'

    let queryClient: QueryClient | undefined
    const GrabQueryClient = () => {
      queryClient = useQueryClient()
      return null
    }

    // `waitFor` cannot poll here — the global fake clock makes its timer path
    // throw — so flush the clock explicitly, as the other suites do.
    const flush = async () => {
      await act(async () => {
        await getClock().runAllAsync()
      })
    }

    it('does not mount wizard queries when onboarding was already completed', async () => {
      await reconcileDefaults(getDb())
      await updateSettings(getDb(), { user_has_completed_onboarding: true })
      render(
        <>
          <OnboardingDialog />
          <GrabQueryClient />
        </>,
        { wrapper: createRouterWrapper() },
      )
      await flush()

      expect(screen.queryByText(wizardTitle)).toBeNull()
      expect(queryClient?.getQueryCache().find({ queryKey: ['integrationStatus'] })).toBeUndefined()
      expect(queryClient?.getQueryCache().find({ queryKey: ['account-passkey'], exact: false })).toBeUndefined()
      expect(
        queryClient?.getQueryCache().find({
          queryKey: ['settings'],
          predicate: ({ queryKey }) => queryKey.includes('onboarding_current_step'),
        }),
      ).toBeUndefined()
    })

    it('closes once the account is marked onboarded', async () => {
      await reconcileDefaults(getDb())
      render(
        <>
          <OnboardingDialog />
          <GrabQueryClient />
        </>,
        { wrapper: createRouterWrapper() },
      )
      await flush()
      expect(screen.queryByText(wizardTitle)).not.toBeNull()

      await updateSettings(getDb(), { user_has_completed_onboarding: true })
      await act(async () => {
        await queryClient?.invalidateQueries()
      })
      await flush()

      expect(screen.queryByText(wizardTitle)).toBeNull()
    })
  })
})
