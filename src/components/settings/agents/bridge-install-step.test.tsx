/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { BridgeInstallStep } from './bridge-install-step'

afterEach(cleanup)

describe('BridgeInstallStep', () => {
  it('on web shows only the manual install command (no auto button)', () => {
    render(<BridgeInstallStep autoInstallable={false} />)

    expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument()
    expect(screen.queryByTestId('bridge-install-auto')).not.toBeInTheDocument()
  })

  it('on desktop shows the auto-install button plus a manual fallback', () => {
    render(<BridgeInstallStep autoInstallable={true} installFn={() => Promise.resolve('ok')} />)

    expect(screen.getByTestId('bridge-install-auto')).toHaveTextContent(/install automatically/i)
    // The manual command is still available (in the collapsible fallback).
    expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument()
  })

  it('runs the installer and shows "Installed" on success', async () => {
    const installFn = mock(() => Promise.resolve('installed to /usr/local/bin/thunderbolt'))
    render(<BridgeInstallStep autoInstallable={true} installFn={installFn} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('bridge-install-auto'))
    })

    expect(installFn).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('bridge-install-auto')).toHaveTextContent(/installed/i))
    expect(screen.getByTestId('bridge-install-auto')).toBeDisabled()
  })

  it('surfaces the installer error and keeps the manual fallback', async () => {
    const installFn = mock(() => Promise.reject(new Error('installer exited with status 1: npm bin not writable')))
    render(<BridgeInstallStep autoInstallable={true} installFn={installFn} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('bridge-install-auto'))
    })

    await waitFor(() => expect(screen.getByTestId('bridge-install-error')).toBeInTheDocument())
    expect(screen.getByTestId('bridge-install-error')).toHaveTextContent(/npm bin not writable/)
    expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument()
  })
})
