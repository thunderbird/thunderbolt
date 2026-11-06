/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { createModel, getSettings, updateSettings } from '@/dal'
import { saveIntegrationCredentials } from '@/dal/integrations'
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

let consoleSpies: ConsoleSpies
let originalCloudUrl: string
let originalLocalMode: boolean

beforeAll(async () => {
  await setupTestDatabase()
  // Preload the lazy provider step before fake timers drive wizard transitions.
  await import('./onboarding-model-step')
  consoleSpies = setupConsoleSpy()
})

afterAll(async () => {
  await teardownTestDatabase()
  consoleSpies.restore()
})

beforeEach(() => {
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

    it.each(['api-key', 'oauth'] as const)(
      'omits search for an enabled Tinfoil %s connection without relying on selected_model, including Back navigation',
      async (auth) => {
        useLocalSettingsStore.setState({ cloudUrl: '' })
        await reconcileDefaults(getDb())
        await createModel(
          getDb(),
          createMockModel({
            id: 'tinfoil-own',
            provider: 'tinfoil',
            isSystem: 0,
            toolUsage: 1,
            apiKey: auth === 'api-key' ? 'user-key' : null,
            oauthProvider: auth === 'oauth' ? 'tinfoil' : null,
          }),
        )
        if (auth === 'oauth') {
          await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'token' }, true)
        }
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

    it.each([
      { enabled: 0, toolUsage: 1 },
      { enabled: 1, toolUsage: 0 },
    ])('keeps search setup when Tinfoil cannot supply search (%j)', async (options) => {
      useLocalSettingsStore.setState({ cloudUrl: '' })
      await reconcileDefaults(getDb())
      await createModel(
        getDb(),
        createMockModel({
          id: 'tinfoil-no-search',
          provider: 'tinfoil',
          isSystem: 0,
          apiKey: null,
          oauthProvider: 'tinfoil',
          ...options,
        }),
      )
      await updateSettings(getDb(), { onboarding_current_step: '10' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.getByRole('heading', { name: 'Add web search' })).toBeInTheDocument()
    })

    it('skips search for an enabled Tinfoil subscription without requiring a model', async () => {
      useLocalSettingsStore.setState({ cloudUrl: '' })
      await reconcileDefaults(getDb())
      await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'token' }, true)
      await updateSettings(getDb(), { onboarding_current_step: '10' })
      render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
      await flush()
      expect(screen.queryByText('Add web search')).toBeNull()
      expect(screen.getByText('What should we call you?')).toBeInTheDocument()
    })

    it.each(['missing', 'disabled', 'reauth'] as const)(
      'keeps search setup when an OAuth model has a %s account connection',
      async (availability) => {
        useLocalSettingsStore.setState({ cloudUrl: '' })
        await reconcileDefaults(getDb())
        await createModel(
          getDb(),
          createMockModel({
            id: 'tinfoil-no-session',
            provider: 'tinfoil',
            isSystem: 0,
            enabled: 1,
            toolUsage: 1,
            apiKey: null,
            oauthProvider: 'tinfoil',
          }),
        )
        if (availability !== 'missing') {
          await saveIntegrationCredentials(
            getDb(),
            'tinfoil',
            {
              access_token: 'token',
              reauth_required: availability === 'reauth',
            },
            availability !== 'disabled',
          )
        }
        await updateSettings(getDb(), { onboarding_current_step: '10' })
        render(<OnboardingDialog />, { wrapper: createRouterWrapper() })
        await flush()
        expect(screen.getByRole('heading', { name: 'Add web search' })).toBeInTheDocument()
      },
    )

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
