import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Dialog } from '@/components/ui/dialog'
import { InstallWarningDialogContent } from './install-warning-dialog'

const noop = () => {}

const renderDialog = (props: { agentName?: string; onConfirm?: () => void; onCancel?: () => void }) =>
  render(
    <Dialog open={true}>
      <InstallWarningDialogContent
        agentName={props.agentName ?? 'Claude Agent'}
        onConfirm={props.onConfirm ?? noop}
        onCancel={props.onCancel ?? noop}
      />
    </Dialog>,
  )

describe('InstallWarningDialogContent', () => {
  beforeEach(() => {
    cleanup()
  })

  it('shows the agent name', () => {
    renderDialog({ agentName: 'Goose' })
    expect(screen.getByText(/Goose/)).toBeDefined()
  })

  it('shows security warning text', () => {
    renderDialog({})
    expect(screen.getByText(/not maintained by Thunderbolt/)).toBeDefined()
    expect(screen.getByText(/security or privacy risks/)).toBeDefined()
  })

  it('has a cancel button', () => {
    renderDialog({})
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it('has an install anyway button', () => {
    renderDialog({})
    expect(screen.getByRole('button', { name: /Install/i })).toBeDefined()
  })

  it('calls onCancel when Cancel clicked', () => {
    const onCancel = mock(() => {})
    renderDialog({ onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onConfirm when Install Anyway clicked', () => {
    const onConfirm = mock(() => {})
    renderDialog({ onConfirm })
    fireEvent.click(screen.getByRole('button', { name: /Install/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
