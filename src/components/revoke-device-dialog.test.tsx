/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { RevokeDeviceDialog } from './revoke-device-dialog'

describe('RevokeDeviceDialog', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders with pending variant wording', () => {
    render(
      <RevokeDeviceDialog
        open={true}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
        variant="pending"
      />,
    )

    expect(screen.getByText('Deny this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will deny the device access to your encrypted data. The device will need to set up sync again.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('renders with trusted variant wording', () => {
    render(
      <RevokeDeviceDialog
        open={true}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
        variant="trusted"
      />,
    )

    expect(screen.getByText('Revoke this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The device will be signed out and lose access to your synced data, and it will need to sign in again to use sync. Data already stored on it is not erased remotely — that device is asked whether to keep or delete its local copy. Your recovery phrase keeps working.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
  })

  it('does not warn that revoking changes the recovery phrase', () => {
    // Revocation re-anchors the recovery slot to the same phrase-derived public
    // keys, so it is a silent operation for the user.
    render(<RevokeDeviceDialog open onOpenChange={() => {}} onConfirm={() => {}} isPending={false} variant="trusted" />)

    const description = screen.getByText(/will be signed out/)
    expect(description.textContent).not.toContain('new recovery phrase')
    expect(description.textContent).toContain('recovery phrase keeps working')
  })

  it('does not promise that local data is erased remotely', () => {
    // The revoked device defaults to "Keep data on device" and only clears on an
    // explicit choice, so promising a wipe here would mislead someone revoking a
    // lost or stolen device.
    render(<RevokeDeviceDialog open onOpenChange={() => {}} onConfirm={() => {}} isPending={false} variant="trusted" />)

    const description = screen.getByText(/will be signed out/)
    expect(description.textContent).toContain('not erased remotely')
    expect(description.textContent).not.toContain('cleared on next sync')
  })

  it('does not render content when closed', () => {
    render(
      <RevokeDeviceDialog
        open={false}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
        variant="pending"
      />,
    )

    expect(screen.queryByText('Deny this device?')).not.toBeInTheDocument()
  })

  it('calls onConfirm when action button is clicked', () => {
    const onConfirm = mock()
    render(
      <RevokeDeviceDialog
        open={true}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        isPending={false}
        variant="pending"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows pending loading state for pending variant', () => {
    render(
      <RevokeDeviceDialog
        open={true}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={true}
        variant="pending"
      />,
    )

    expect(screen.getByText('Denying…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Denying…' })).toBeDisabled()
  })

  it('shows pending loading state for trusted variant', () => {
    render(
      <RevokeDeviceDialog
        open={true}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={true}
        variant="trusted"
      />,
    )

    expect(screen.getByText('Revoking…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revoking…' })).toBeDisabled()
  })
})
