/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { thunderboltCloudUrl } from '@/lib/constants'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { OnboardingServerStep } from './onboarding-server-step'
import { useOnboardingServerState } from './use-onboarding-server-state'

const SetupStep = ({ onSignIn = mock(), onContinueLocal = mock() }) => {
  const serverState = useOnboardingServerState()
  return (
    <>
      <OnboardingServerStep serverState={serverState} onSignIn={onSignIn} onContinueLocal={onContinueLocal} />
      {serverState.isChoosingSetup && (
        <button disabled={serverState.isBusy} onClick={() => serverState.continueSetup(onContinueLocal)}>
          Continue
        </button>
      )}
    </>
  )
}

describe('OnboardingServerStep', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  beforeEach(() => {
    useLocalSettingsStore.setState({
      cloudUrl: '',
      localMode: true,
      serverHasAuthenticated: false,
      syncEnabled: false,
    })
  })

  it('lets device setup continue without choosing a server or signing in', () => {
    const onSignIn = mock()
    const onContinueLocal = mock()
    const fetchSpy = spyOn(globalThis, 'fetch')
    try {
      render(<SetupStep onSignIn={onSignIn} onContinueLocal={onContinueLocal} />, { wrapper: createTestProvider() })

      expect(screen.getByRole('radio', { name: 'Cloud (Waitlist)' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Enterprise' })).toBeInTheDocument()
      expect(screen.queryByLabelText('Thunderbolt server address')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
      expect(screen.getAllByRole('radio')[0]).toHaveAccessibleName('Local')
      expect(screen.getByRole('radio', { name: 'Local' })).toBeChecked()
      fireEvent.click(screen.getByRole('radio', { name: 'Cloud (Waitlist)' }))
      expect(fetchSpy).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('radio', { name: 'Local' }))
      expect(screen.getByRole('radio', { name: 'Local' })).toBeChecked()
      expect(screen.getByRole('radio', { name: 'Cloud (Waitlist)' })).not.toBeChecked()
      expect(onContinueLocal).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

      expect(onContinueLocal).toHaveBeenCalledTimes(1)
      expect(onSignIn).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('asks for an organization server without adding a second Back button', () => {
    const onSignIn = mock()
    render(<SetupStep onSignIn={onSignIn} />, { wrapper: createTestProvider() })

    fireEvent.click(screen.getByRole('radio', { name: 'Enterprise' }))
    expect(screen.queryByLabelText('Thunderbolt server address')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByLabelText('Thunderbolt server address')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Cloud (Waitlist)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back to options' })).not.toBeInTheDocument()
    expect(onSignIn).not.toHaveBeenCalled()
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
  })

  it('shows the actual Cloud waitlist and only sends email when the user submits', async () => {
    useLocalSettingsStore.setState({ cloudUrl: thunderboltCloudUrl })
    const onSignIn = mock()
    const httpClient = createMockHttpClient({ success: true, challengeToken: 'cloud-challenge' })
    const post = spyOn(httpClient, 'post')
    render(<SetupStep onSignIn={onSignIn} />, { wrapper: createTestProvider({ httpClient }) })

    expect(screen.getByText('Want early access?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign In' })).not.toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
    expect(onSignIn).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'person@example.com' } })
    expect(post).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })))

    expect(post).toHaveBeenCalledWith('waitlist/join', {
      json: { email: 'person@example.com' },
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByText('Check your email')).toBeInTheDocument()
    expect(screen.getByText('If you received a code to log in, enter it here:')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it('shows the selected organization server before sign-in and keeps local setup available', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://work.example.com/v1' })
    const onSignIn = mock()
    const onContinueLocal = mock()
    render(<SetupStep onSignIn={onSignIn} onContinueLocal={onContinueLocal} />, { wrapper: createTestProvider() })

    expect(screen.getByText('Selected server')).toBeInTheDocument()
    expect(screen.getByText('https://work.example.com/v1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change server' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Cloud (Waitlist)' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    expect(onSignIn).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Continue setup without signing in' }))
    expect(onContinueLocal).toHaveBeenCalledTimes(1)
    expect(useLocalSettingsStore.getState().cloudUrl).toBe('https://work.example.com/v1')
  })
})
