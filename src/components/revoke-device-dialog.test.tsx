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
        'The device will be signed out and its local data will be cleared on next sync. This device will need to sign in again to use sync.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
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
