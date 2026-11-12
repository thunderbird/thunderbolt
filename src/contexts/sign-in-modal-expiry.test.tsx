/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { showSignInModalEvent } from '@/hooks/use-credential-events'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { SignInModalProvider } from './sign-in-modal-context'

const originalConfig = useConfigStore.getState().config

describe('dismissing expired sign-in', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
    useConfigStore.setState({ config: originalConfig })
  })

  it.each([true, false])('preserves local work only when localMode is %s', async (localMode) => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://organization.example/v1', localMode })
    useConfigStore.setState({ config: { authMode: 'oidc' } })
    const replace = spyOn(window.location, 'replace').mockImplementation(() => {})
    try {
      render(
        <SignInModalProvider>
          <p>Local work</p>
        </SignInModalProvider>,
        { wrapper: createTestProvider() },
      )
      await act(async () => window.dispatchEvent(new CustomEvent(showSignInModalEvent)))

      expect(screen.getByRole('button', { name: 'Continue with organization' })).toBeInTheDocument()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })

      if (localMode) {
        expect(replace).not.toHaveBeenCalled()
      } else {
        expect(replace).toHaveBeenCalledWith('/sso-redirect')
      }
    } finally {
      replace.mockRestore()
    }
  })
})
