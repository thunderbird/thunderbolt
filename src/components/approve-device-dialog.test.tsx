/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ApproveDeviceDialog } from './approve-device-dialog'
import { DeviceApprovalError } from '@/crypto/errors'
import { HttpError } from '@/lib/http'

const device = { id: 'pending-1', publicKey: 'ecdh-1', mlkemPublicKey: 'mlkem-1' }
const fingerprint = 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C'
const enterFingerprint = () =>
  fireEvent.change(screen.getByLabelText('Device fingerprint'), { target: { value: fingerprint } })

describe('ApproveDeviceDialog', () => {
  let errorLog: ReturnType<typeof spyOn>
  beforeEach(() => {
    errorLog = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    errorLog.mockRestore()
  })

  it('logs unexpected failure locally without the thrown message, keys or response body', async () => {
    const onConfirm = async () => {
      throw new Error('private response body', { cause: { key: 'private-key-marker' } })
    }
    render(<ApproveDeviceDialog device={device} open onOpenChange={() => {}} onConfirm={onConfirm} isPending={false} />)
    enterFingerprint()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    expect(errorLog.mock.calls).toEqual([['Failed to approve device.']])
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't approve this device. Please try again.")
  })

  it('renders title and description when open', () => {
    render(
      <ApproveDeviceDialog
        device={device}
        open={true}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
      />,
    )

    expect(screen.getByText('Approve this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will share your encryption key with the device, allowing it to decrypt and sync your data.',
      ),
    ).toBeInTheDocument()
  })

  it('does not render content when closed', () => {
    render(
      <ApproveDeviceDialog
        device={device}
        open={false}
        onOpenChange={() => {}}
        onConfirm={() => {}}
        isPending={false}
      />,
    )

    expect(screen.queryByText('Approve this device?')).not.toBeInTheDocument()
  })

  it('calls onConfirm when Approve is clicked', async () => {
    const onConfirm = mock()
    render(
      <ApproveDeviceDialog
        device={device}
        open={true}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        isPending={false}
      />,
    )

    enterFingerprint()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows loading state when isPending', () => {
    render(
      <ApproveDeviceDialog device={device} open={true} onOpenChange={() => {}} onConfirm={() => {}} isPending={true} />,
    )

    expect(screen.getByText('Approving…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('disables buttons when isPending', () => {
    render(
      <ApproveDeviceDialog device={device} open={true} onOpenChange={() => {}} onConfirm={() => {}} isPending={true} />,
    )

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
  })

  it('requires a complete fingerprint and resets it when the recipient keys change', () => {
    const props = { open: true, onOpenChange: () => {}, onConfirm: () => {}, isPending: false }
    const view = render(<ApproveDeviceDialog {...props} device={device} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Device fingerprint'), {
      target: { value: 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680' },
    })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    enterFingerprint()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    view.rerender(<ApproveDeviceDialog {...props} device={{ ...device, publicKey: 'replaced' }} />)
    expect(screen.getByLabelText('Device fingerprint')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('allows only one submit while the promise is unresolved', async () => {
    let finish: (() => void) | undefined
    const onConfirm = mock(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<ApproveDeviceDialog device={device} open onOpenChange={() => {}} onConfirm={onConfirm} isPending={false} />)
    enterFingerprint()
    const button = screen.getByRole('button', { name: 'Approve' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(fingerprint)
    await act(async () => finish?.())
  })

  it.each([
    [
      new DeviceApprovalError('fingerprint-mismatch'),
      "The fingerprint doesn't match. Check the fingerprint shown on the new device and try again.",
    ],
    [
      new HttpError(new Response(null, { status: 409 })),
      "Couldn't complete approval. Close this dialog and check the device list before trying again.",
    ],
    [new Error('Internal diagnostic'), "Couldn't approve this device. Please try again."],
  ])('keeps a rejected confirmation open and explains the failure', async (failure, message) => {
    const onConfirm = mock(async () => {
      throw failure
    })
    const onOpenChange = mock(() => {})
    render(
      <ApproveDeviceDialog device={device} open onOpenChange={onOpenChange} onConfirm={onConfirm} isPending={false} />,
    )
    enterFingerprint()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('alertdialog')).toBeVisible()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })
})
