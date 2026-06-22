/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { StorageUnavailableScreen } from './storage-unavailable-screen'

const setUserAgent = (value: string) => {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
}

describe('StorageUnavailableScreen', () => {
  const originalUserAgent = navigator.userAgent

  afterEach(() => {
    cleanup()
    setUserAgent(originalUserAgent)
  })

  it('renders the generic storage copy by default', () => {
    render(<StorageUnavailableScreen />)
    expect(screen.getByRole('heading', { name: 'Storage is disabled' })).toBeInTheDocument()
    expect(screen.getByText(/This can happen in private windows or when site data is blocked/)).toBeInTheDocument()
    expect(screen.queryByText(/iOS Lockdown Mode/)).not.toBeInTheDocument()
  })

  it('renders the Lockdown Mode hint on iOS', () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    )
    render(<StorageUnavailableScreen />)
    expect(screen.getByText(/iOS Lockdown Mode/)).toBeInTheDocument()
    expect(screen.getByText(/Configure Web Browsing/)).toBeInTheDocument()
  })
})
