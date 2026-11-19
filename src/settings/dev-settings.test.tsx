/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import DevSettingsPage from './dev-settings'

const originalSettings = useLocalSettingsStore.getState()

afterEach(() => {
  cleanup()
  useLocalSettingsStore.setState(originalSettings)
})

describe('developer server settings', () => {
  it('keeps a configured server read-only instead of mutating the active auth destination', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://first.example/v1' })
    render(<DevSettingsPage />, { wrapper: createQueryTestWrapper() })
    const input = screen.getByRole('textbox', { name: 'Thunderbolt Server' }) as HTMLInputElement
    expect(input.readOnly).toBe(true)

    fireEvent.change(input, { target: { value: 'https://second.example/v1' } })

    expect(useLocalSettingsStore.getState().cloudUrl).toBe('https://first.example/v1')
    expect(screen.queryByRole('button', { name: 'Connect to server' })).toBeNull()
  })

  it('offers the validated server form before any server is configured', () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    render(<DevSettingsPage />, { wrapper: createQueryTestWrapper() })
    fireEvent.change(screen.getByLabelText('Thunderbolt server address'), {
      target: { value: 'https://candidate.example' },
    })

    expect(useLocalSettingsStore.getState().cloudUrl).toBe('')
    expect(screen.getByRole('button', { name: 'Connect to server' })).toBeEnabled()
  })
})
