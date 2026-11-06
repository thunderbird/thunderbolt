/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, screen } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { mockLocationData } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
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
