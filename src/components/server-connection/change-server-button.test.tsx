/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearAuthToken } from '@/lib/auth-token'
import { clearCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { ChangeServerButton } from './change-server-button'

describe('ChangeServerButton', () => {
  afterEach(cleanup)

  it('forgets an unused server and reloads before accepting a replacement', () => {
    clearAuthToken()
    clearCachedSession()
    useLocalSettingsStore.setState({
      cloudUrl: 'https://wrong.example/v1',
      localMode: true,
      serverHasAuthenticated: false,
      syncEnabled: false,
    })
    const reload = spyOn(window.location, 'reload').mockImplementation(() => {})
    try {
      render(<ChangeServerButton />)
      fireEvent.click(screen.getByRole('button', { name: 'Change server' }))
      expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      reload.mockRestore()
    }
  })

  it('does not expose account switching for a previously authenticated server', () => {
    useLocalSettingsStore.setState({
      cloudUrl: 'https://account.example/v1',
      localMode: true,
      serverHasAuthenticated: true,
    })
    render(<ChangeServerButton />)
    expect(screen.queryByRole('button', { name: 'Change server' })).not.toBeInTheDocument()
  })
})
