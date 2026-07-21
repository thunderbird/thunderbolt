/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { AddCustomAgentDialog, type AddCustomAgentPayload, type TestAcpConnectionFn } from './add-custom-agent-dialog'

afterEach(() => {
  cleanup()
})

describe('AddCustomAgentDialog', () => {
  const notIos = () => false

  const succeedingProbe: TestAcpConnectionFn = async () => ({ success: true })

  it('keeps Add Agent disabled until both name and URL are filled and the connection test succeeds', async () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isIos={notIos}
        testAcpConnection={succeedingProbe}
      />,
    )

    const submit = screen.getByRole('button', { name: /add agent/i })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'My Agent' } })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })
    // Name + URL alone no longer enable Add — a successful test is required.
    expect(submit).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })
    expect(submit).not.toBeDisabled()
  })

  it('invokes onSubmit with websocket transport and trimmed values', async () => {
    const onSubmit = mock(async (_: AddCustomAgentPayload) => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isIos={notIos}
        testAcpConnection={succeedingProbe}
      />,
    )

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  My Agent  ' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: '  wss://example.com/ws  ' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Demo' } })

    // Add is gated behind a successful test — run it first.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add agent/i }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'My Agent',
      url: 'wss://example.com/ws',
      description: 'Demo',
      transport: 'websocket',
    })
    // Closes dialog on success.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open with submit re-enabled when onSubmit rejects', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const onSubmit = mock(async () => {
      throw new Error('insert failed')
    })
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isIos={notIos}
        testAcpConnection={succeedingProbe}
      />,
    )

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add agent/i }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    // The dialog stays open with the form intact so the user can retry.
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/name/i)).toHaveValue('My Agent')
    expect(screen.getByRole('button', { name: /add agent/i })).not.toBeDisabled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('shows the iOS rejection inline for ws:// at render time, keeps Add disabled, and does NOT call onSubmit', () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(<AddCustomAgentDialog open={true} onOpenChange={onOpenChange} onSubmit={onSubmit} isIos={() => true} />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'iOS Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'ws://example.com/ws' } })

    // The error surfaces on entering the invalid URL — no Add click needed.
    expect(screen.getByRole('alert')).toHaveTextContent(/secure/i)
    expect(screen.getByRole('button', { name: /add agent/i })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows an inline error for http:// (unsupported scheme) at render time and keeps Add disabled', () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(<AddCustomAgentDialog open={true} onOpenChange={onOpenChange} onSubmit={onSubmit} isIos={notIos} />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Bad Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'http://example.com' } })

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add agent/i })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows an inline error for unsupported schemes at render time and keeps Add disabled', () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(<AddCustomAgentDialog open={true} onOpenChange={onOpenChange} onSubmit={onSubmit} isIos={notIos} />)

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Bad Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'ftp://example.com' } })

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add agent/i })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AddCustomAgentDialog — connection status', () => {
  const notIos = () => false

  const renderWithProbe = (testAcpConnection: TestAcpConnectionFn) => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isIos={notIos}
        testAcpConnection={testAcpConnection}
      />,
    )
    return { onSubmit, onOpenChange }
  }

  const fillNameAndUrl = () => {
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'My Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })
  }

  it('hides the Test Connection button until the URL is a valid WebSocket endpoint', () => {
    renderWithProbe(async () => ({ success: true }))

    expect(screen.queryByRole('button', { name: /test connection/i })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'http://example.com' } })
    expect(screen.queryByRole('button', { name: /test connection/i })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument()
  })

  it('renders the success StatusCard when the probe resolves success', async () => {
    const probe = mock<TestAcpConnectionFn>(async () => ({ success: true }))
    renderWithProbe(probe)

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })

    expect(probe).toHaveBeenCalledWith({ url: 'wss://example.com/ws' })
    expect(screen.getByText(/connection successful/i)).toBeInTheDocument()
  })

  it('renders the error StatusCard with the probe error message on failure', async () => {
    const probe = mock<TestAcpConnectionFn>(async () => ({ success: false, error: 'Could not reach agent' }))
    renderWithProbe(probe)

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })

    expect(screen.getByText(/connection failed/i)).toBeInTheDocument()
    expect(screen.getByText(/could not reach agent/i)).toBeInTheDocument()
  })

  it('gates Add Agent on a successful connection test', async () => {
    renderWithProbe(async () => ({ success: false, error: 'nope' }))

    const submit = screen.getByRole('button', { name: /add agent/i })
    fillNameAndUrl()

    // Name + URL alone do not enable Add.
    expect(submit).toBeDisabled()

    // A failed test leaves Add disabled.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })
    expect(submit).toBeDisabled()

    // Re-entering a valid URL clears the failure; a successful test enables Add.
    cleanup()
    renderWithProbe(async () => ({ success: true }))
    const submitAfterSuccess = screen.getByRole('button', { name: /add agent/i })
    fillNameAndUrl()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })
    expect(submitAfterSuccess).not.toBeDisabled()
  })

  it('clears a prior connection result when the URL changes', async () => {
    renderWithProbe(async () => ({ success: true }))

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })
    expect(screen.getByText(/connection successful/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://other.com/ws' } })
    expect(screen.queryByText(/connection successful/i)).not.toBeInTheDocument()
  })
})

describe('AddCustomAgentDialog — iroh', () => {
  const notIos = () => false
  const irohTarget = 'a'.repeat(52)
  const appNodeId = 'b'.repeat(52)
  // Stable reference so the load effect's deps don't churn across renders.
  const loadAppNodeId = async () => appNodeId

  const renderIroh = () => {
    const onSubmit = mock(async (_: AddCustomAgentPayload) => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isIos={notIos}
        testAcpConnection={async () => ({ success: true })}
        loadAppNodeId={loadAppNodeId}
      />,
    )
    return { onSubmit, onOpenChange }
  }

  it('hides Test Connection for an iroh target and gates Add on name + valid target only', async () => {
    renderIroh()
    const submit = screen.getByRole('button', { name: /add agent/i })

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Laptop Bridge' } })
    expect(submit).toBeDisabled()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: irohTarget } })
    })

    // Test Connection is WebSocket-only — an iroh bridge is verified on first chat.
    expect(screen.queryByRole('button', { name: /test connection/i })).not.toBeInTheDocument()
    // No connection test is required for iroh, so Add is enabled directly.
    expect(submit).not.toBeDisabled()
  })

  it('shows this app NodeId as an allow command with a copy button', async () => {
    renderIroh()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: irohTarget } })
    })

    const panel = screen.getByTestId('iroh-pairing-panel')
    await waitFor(() => expect(panel.textContent).toContain(`thunderbolt iroh allow ${appNodeId}`))
    expect(screen.getByRole('button', { name: /copy allow command/i })).toBeInTheDocument()
  })

  it('surfaces an error when the app pairing identity fails to load', async () => {
    const onSubmit = mock(async () => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        isIos={notIos}
        loadAppNodeId={async () => {
          throw new Error('relay unreachable')
        }}
      />,
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: irohTarget } })
    })

    const panel = screen.getByTestId('iroh-pairing-panel')
    await waitFor(() => expect(panel.textContent).toMatch(/relay unreachable/i))
  })

  it('re-loads the app NodeId after a reset and an iroh target is re-entered (no stuck "Loading")', async () => {
    let calls = 0
    const countingLoad = async () => {
      calls += 1
      return appNodeId
    }
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
        isIos={notIos}
        testAcpConnection={async () => ({ success: true })}
        loadAppNodeId={countingLoad}
      />,
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: irohTarget } })
    })
    await waitFor(() => expect(screen.getByTestId('iroh-pairing-panel').textContent).toContain(appNodeId))
    expect(calls).toBe(1)

    // Cancel resets the form (RESET → appNodeId back to idle, url cleared).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    })

    // Re-entering an iroh target must re-fire the load rather than strand on "Loading".
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: irohTarget } })
    })
    await waitFor(() => expect(screen.getByTestId('iroh-pairing-panel').textContent).toContain(appNodeId))
    expect(calls).toBe(2)
  })

  it('submits with transport: iroh and the target stored as url', async () => {
    const { onSubmit, onOpenChange } = renderIroh()

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  Laptop Bridge  ' } })
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/url/i), { target: { value: `  ${irohTarget}  ` } })
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add agent/i }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Laptop Bridge',
      url: irohTarget,
      description: null,
      transport: 'iroh',
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
