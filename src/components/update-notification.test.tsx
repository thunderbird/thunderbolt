/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import type { DesktopUpdateState, UpdateStatus } from '@/hooks/use-desktop-update'
import { UpdateNotificationContent } from './update-notification'

const downloadAndInstall = mock(async () => {})
const restartApp = mock(async () => {})
const checkForUpdates = mock(async () => {})
const createUpdateState = (status: UpdateStatus, error: string | null = null): DesktopUpdateState => ({
  status,
  update: null,
  error,
  errorPhase: error ? 'check' : null,
  downloadProgress: 0,
  downloadAndInstall,
  restartApp,
  checkForUpdates,
})

afterEach(cleanup)

describe('UpdateNotification', () => {
  it('renders nothing off desktop', () => {
    render(<UpdateNotificationContent desktop={false} updateState={createUpdateState('ready')} />)

    expect(screen.queryByText('Update ready! Restart to apply.')).toBeNull()
  })

  it('shows ready actions in the original corner position and dismisses from the close button', () => {
    render(<UpdateNotificationContent desktop updateState={createUpdateState('ready')} />)

    expect(screen.getByRole('button', { name: 'Restart Now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
    expect(screen.getByText('Update ready! Restart to apply.').closest('.fixed')).toHaveClass('right-4', 'max-w-sm')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Update ready! Restart to apply.')).toBeNull()
  })

  it('offers retry without Later after an error', () => {
    render(<UpdateNotificationContent desktop updateState={createUpdateState('error', 'Network unavailable')} />)

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
  })
})
