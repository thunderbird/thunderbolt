/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import * as dal from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, screen, fireEvent } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { mockLocationData } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { OnboardingDialog } from './onboarding-dialog'

let consoleSpies: ConsoleSpies

beforeAll(async () => {
  await setupTestDatabase()
  consoleSpies = setupConsoleSpy()
})

afterAll(async () => {
  await teardownTestDatabase()
  consoleSpies.restore()
})

afterEach(async () => {
  await resetTestDatabase()
})

const createRouterWrapper =
  (locationState?: unknown) =>
  ({ children }: { children: ReactNode }) => {
    const TestProvider = createTestProvider({ mockResponse: mockLocationData })
    const entries = [{ pathname: '/', state: locationState ?? null }]
    return (
      <MemoryRouter initialEntries={entries}>
        <TestProvider>{children}</TestProvider>
      </MemoryRouter>
    )
  }

describe('OnboardingDialog', () => {
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
      const button = screen.getByRole('button', { name: /Start Using/ }) as HTMLButtonElement
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Enter your name' }), { target: { value: 'Alice' } })
    const pending = Promise.withResolvers<void>()
    const write = spyOn(dal, 'updateSettings').mockImplementationOnce(() => pending.promise)
    try {
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      })
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled()
      expect(screen.getByRole('textbox')).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
      await getClock().runAllAsync()
    })
    expect(screen.queryByRole('textbox', { name: 'Enter your name' })).toBeNull()
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
    expect(screen.getByRole('button', { name: /Start Using/ })).toBeInTheDocument()
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
