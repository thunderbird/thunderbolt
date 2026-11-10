/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ApproveDeviceDialog } from './approve-device-dialog'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { DeviceApprovalError } from '@/crypto/errors'
import { HttpError } from '@/lib/http'
import { createMockHttpClient } from '@/test-utils/http-client'
import type { ComponentProps, ReactNode } from 'react'
import { approvalCodeAttemptsKey, startApprovalCodeAttempt } from './approval-code-attempts'

const device = { id: 'pending-1', publicKey: 'ecdh-1', mlkemPublicKey: 'mlkem-1' }
const fingerprint = 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C'
const enterFingerprint = () =>
  fireEvent.change(screen.getByLabelText('Device fingerprint'), { target: { value: fingerprint } })
const openFingerprint = () => fireEvent.click(screen.getByRole('button', { name: 'Use fingerprint instead' }))

const wrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={createMockHttpClient()}>{children}</HttpClientProvider>
)
type DialogProps = ComponentProps<typeof ApproveDeviceDialog>
const defaults: DialogProps = {
  device,
  open: true,
  onOpenChange: () => {},
  onConfirm: () => {},
  onDeny: () => {},
  isPending: false,
}
const renderDialog = (props: Partial<DialogProps> = {}) =>
  render(<ApproveDeviceDialog {...defaults} {...props} />, { wrapper })

describe('ApproveDeviceDialog', () => {
  let errorLog: ReturnType<typeof spyOn>
  beforeEach(() => {
    localStorage.removeItem(approvalCodeAttemptsKey)
    errorLog = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    errorLog.mockRestore()
    localStorage.removeItem(approvalCodeAttemptsKey)
  })

  it('opens straight on the codes, with the fingerprint one tap away', () => {
    renderDialog()
    expect(screen.getByText('Which code is on the new device?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'None of these match' })).toBeDisabled()
    openFingerprint()
    expect(screen.getByLabelText('Device fingerprint')).toBeInTheDocument()
  })

  it('opens on the fingerprint once too many codes failed today', () => {
    startApprovalCodeAttempt()
    startApprovalCodeAttempt()
    startApprovalCodeAttempt()
    renderDialog()
    expect(screen.queryByText('Which code is on the new device?')).toBeNull()
    expect(
      screen.getByText("Too many codes didn't match on this device today, so approve with the fingerprint instead."),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Device fingerprint')).toBeInTheDocument()
  })

  it('logs unexpected failure locally without the thrown message, keys or response body', async () => {
    const onConfirm = async () => {
      throw new Error('private response body', { cause: { key: 'private-key-marker' } })
    }
    renderDialog({ onConfirm })
    openFingerprint()
    enterFingerprint()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    expect(errorLog.mock.calls).toEqual([['Failed to approve device.']])
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't approve this device. Please try again.")
  })

  it('renders the fingerprint title and description', () => {
    renderDialog()
    openFingerprint()

    expect(screen.getByText('Approve this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will share your encryption key with the device, allowing it to decrypt and sync your data.',
      ),
    ).toBeInTheDocument()
  })

  it('does not render content when closed', () => {
    renderDialog({ open: false })

    expect(screen.queryByText('Which code is on the new device?')).not.toBeInTheDocument()
  })

  it('calls onConfirm when Approve is clicked', async () => {
    const onConfirm = mock()
    renderDialog({ onConfirm })
    openFingerprint()

    enterFingerprint()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'fingerprint', fingerprint })
  })

  it('shows loading state when isPending', () => {
    const view = renderDialog()
    openFingerprint()
    view.rerender(<ApproveDeviceDialog {...defaults} isPending />)

    expect(screen.getByText('Approving…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('disables buttons when isPending', () => {
    const view = renderDialog()
    openFingerprint()
    view.rerender(<ApproveDeviceDialog {...defaults} isPending />)

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
  })

  it('requires a complete fingerprint and resets it when the recipient keys change', () => {
    const view = renderDialog()
    openFingerprint()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Device fingerprint'), {
      target: { value: 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680' },
    })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    enterFingerprint()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    view.rerender(<ApproveDeviceDialog {...defaults} device={{ ...device, publicKey: 'replaced' }} />)
    expect(screen.getByText('Which code is on the new device?')).toBeInTheDocument()
    openFingerprint()
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
    renderDialog({ onConfirm })
    openFingerprint()
    enterFingerprint()
    const button = screen.getByRole('button', { name: 'Approve' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'fingerprint', fingerprint })
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
    renderDialog({ onOpenChange, onConfirm })
    openFingerprint()
    enterFingerprint()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('alertdialog')).toBeVisible()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })
})
