/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Agent } from '@/types/acp'
import {
  AddCustomAgentDialog,
  inferTransport,
  validateAgentUrl,
  type AddCustomAgentPayload,
  type TestAcpConnectionFn,
} from './add-custom-agent-dialog'

afterEach(() => {
  cleanup()
})

describe('inferTransport', () => {
  it('returns websocket for wss:// URLs', () => {
    expect(inferTransport('wss://example.com/ws')).toBe('websocket')
  })

  it('returns websocket for ws:// URLs', () => {
    expect(inferTransport('ws://example.com/ws')).toBe('websocket')
  })

  it('returns null for http:// URLs (unsupported)', () => {
    expect(inferTransport('http://example.com/acp')).toBeNull()
  })

  it('returns null for https:// URLs (unsupported)', () => {
    expect(inferTransport('https://example.com/acp')).toBeNull()
  })

  it('returns null for unsupported schemes', () => {
    expect(inferTransport('ftp://example.com/acp')).toBeNull()
  })

  it('returns null for malformed URLs', () => {
    expect(inferTransport('not a url')).toBeNull()
    expect(inferTransport('')).toBeNull()
  })
})

describe('validateAgentUrl', () => {
  const notIos = () => false
  const isIos = () => true

  it('accepts wss:// on non-iOS platforms', () => {
    expect(validateAgentUrl('wss://example.com', notIos)).toEqual({ transport: 'websocket' })
  })

  it('accepts ws:// on non-iOS platforms (LAN/dev use)', () => {
    expect(validateAgentUrl('ws://localhost:8080/ws', notIos)).toEqual({ transport: 'websocket' })
  })

  it('rejects http:// with a clear "WebSocket only" message', () => {
    const result = validateAgentUrl('http://example.com/acp', notIos)
    expect('error' in result && result.error).toMatch(/WebSocket|wss:\/\/|ws:\/\//i)
  })

  it('rejects https:// with a clear "WebSocket only" message', () => {
    const result = validateAgentUrl('https://example.com/acp', notIos)
    expect('error' in result && result.error).toMatch(/WebSocket|wss:\/\/|ws:\/\//i)
  })

  it('rejects unsupported schemes with a user-facing message', () => {
    const result = validateAgentUrl('ftp://example.com', notIos)
    expect('error' in result && result.error).toMatch(/WebSocket|wss:\/\/|ws:\/\//i)
  })

  it('rejects ws:// on Tauri iOS (ATS forbids cleartext)', () => {
    const result = validateAgentUrl('ws://example.com', isIos)
    expect('error' in result && result.error).toMatch(/iOS.*secure/i)
  })

  it('still accepts wss:// on Tauri iOS', () => {
    expect(validateAgentUrl('wss://example.com', isIos)).toEqual({ transport: 'websocket' })
  })
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
      // Personal workspace by default in tests → picker hidden → falls back
      // to workspace scope to match historical behavior.
      scope: 'workspace',
    })
    // Closes dialog on success.
    expect(onOpenChange).toHaveBeenCalledWith(false)
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

describe('AddCustomAgentDialog — edit mode', () => {
  const notIos = () => false

  const existingAgent: Agent = {
    id: 'custom-1',
    name: 'Existing Agent',
    type: 'remote-acp',
    transport: 'websocket',
    url: 'wss://existing.example/ws',
    description: 'Existing description',
    icon: null,
    isSystem: 0,
    enabled: 1,
    deletedAt: null,
    userId: 'user-42',
  }

  it('renders the Edit title and Save Changes button when editingAgent is set', () => {
    const onSubmit = mock(async () => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        editingAgent={existingAgent}
        isIos={notIos}
        testAcpConnection={async () => ({ success: true })}
      />,
    )

    expect(screen.getByText(/edit custom agent/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()
    // Add Agent label must not appear in edit mode.
    expect(screen.queryByRole('button', { name: /^add agent$/i })).not.toBeInTheDocument()
  })

  it('seeds the form with the existing agent values', () => {
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
        editingAgent={existingAgent}
        isIos={notIos}
        testAcpConnection={async () => ({ success: true })}
      />,
    )

    expect(screen.getByLabelText(/name/i)).toHaveValue('Existing Agent')
    expect(screen.getByLabelText(/url/i)).toHaveValue('wss://existing.example/ws')
    expect(screen.getByLabelText(/description/i)).toHaveValue('Existing description')
  })

  it('keeps Save Changes gated until the seeded URL is re-tested', async () => {
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
        editingAgent={existingAgent}
        isIos={notIos}
        testAcpConnection={async () => ({ success: true })}
      />,
    )

    const save = screen.getByRole('button', { name: /save changes/i })
    // Form is prefilled but connection has not been re-verified yet.
    expect(save).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })

    expect(save).not.toBeDisabled()
  })

  it('invokes onSubmit with the edited values after a successful test', async () => {
    const onSubmit = mock(async (_: AddCustomAgentPayload) => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        editingAgent={existingAgent}
        isIos={notIos}
        testAcpConnection={async () => ({ success: true })}
      />,
    )

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Renamed Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://new.example/ws' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: '' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /test connection/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Renamed Agent',
      url: 'wss://new.example/ws',
      // Empty description is normalized to null, matching the create path.
      description: null,
      transport: 'websocket',
      scope: 'workspace',
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
