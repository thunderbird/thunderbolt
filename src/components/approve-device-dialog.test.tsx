/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ApproveDeviceDialog } from './approve-device-dialog'

describe('ApproveDeviceDialog', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders title and description when open', () => {
    render(<ApproveDeviceDialog open={true} onOpenChange={() => {}} onConfirm={() => {}} isPending={false} />)

    expect(screen.getByText('Approve this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will share your encryption key with the device, allowing it to decrypt and sync your data.',
      ),
    ).toBeInTheDocument()
  })

  it('does not render content when closed', () => {
    render(<ApproveDeviceDialog open={false} onOpenChange={() => {}} onConfirm={() => {}} isPending={false} />)

    expect(screen.queryByText('Approve this device?')).not.toBeInTheDocument()
  })

  it('calls onConfirm when Approve is clicked', async () => {
    const onConfirm = mock()
    render(<ApproveDeviceDialog open={true} onOpenChange={() => {}} onConfirm={onConfirm} isPending={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows loading state when isPending', () => {
    render(<ApproveDeviceDialog open={true} onOpenChange={() => {}} onConfirm={() => {}} isPending={true} />)

    expect(screen.getByText('Approving…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('disables buttons when isPending', () => {
    render(<ApproveDeviceDialog open={true} onOpenChange={() => {}} onConfirm={() => {}} isPending={true} />)

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
  })
})
