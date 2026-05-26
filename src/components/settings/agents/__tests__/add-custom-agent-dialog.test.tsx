/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  AddCustomAgentDialog,
  inferTransport,
  validateAgentUrl,
  type AddCustomAgentPayload,
} from '../add-custom-agent-dialog'

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

  it('returns http for https:// URLs', () => {
    expect(inferTransport('https://example.com/acp')).toBe('http')
  })

  it('returns http for http:// URLs', () => {
    expect(inferTransport('http://example.com/acp')).toBe('http')
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

  it('accepts https:// on non-iOS platforms', () => {
    expect(validateAgentUrl('https://example.com/acp', notIos)).toEqual({ transport: 'http' })
  })

  it('accepts ws:// on non-iOS platforms (LAN/dev use)', () => {
    expect(validateAgentUrl('ws://localhost:8080/ws', notIos)).toEqual({ transport: 'websocket' })
  })

  it('rejects unsupported schemes with a user-facing message', () => {
    const result = validateAgentUrl('ftp://example.com', notIos)
    expect('error' in result && result.error).toMatch(/wss:\/\/|ws:\/\/|https:\/\/|http:\/\//)
  })

  it('rejects ws:// on Tauri iOS (ATS forbids cleartext)', () => {
    const result = validateAgentUrl('ws://example.com', isIos)
    expect('error' in result && result.error).toMatch(/iOS.*secure/i)
  })

  it('rejects http:// on Tauri iOS', () => {
    const result = validateAgentUrl('http://example.com', isIos)
    expect('error' in result && result.error).toMatch(/iOS.*secure/i)
  })

  it('still accepts wss:// on Tauri iOS', () => {
    expect(validateAgentUrl('wss://example.com', isIos)).toEqual({ transport: 'websocket' })
  })

  it('still accepts https:// on Tauri iOS', () => {
    expect(validateAgentUrl('https://example.com', isIos)).toEqual({ transport: 'http' })
  })
})

describe('AddCustomAgentDialog', () => {
  const notIos = () => false

  it('keeps Add Agent disabled until both name and URL are filled', () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog open={true} onOpenChange={onOpenChange} onSubmit={onSubmit} isIos={notIos} />,
    )

    const submit = screen.getByRole('button', { name: /add agent/i })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'My Agent' } })
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'wss://example.com/ws' } })
    expect(submit).not.toBeDisabled()
  })

  it('invokes onSubmit with the inferred transport and trimmed values', async () => {
    let payload: AddCustomAgentPayload | null = null
    const onSubmit = mock(async (p: AddCustomAgentPayload) => {
      payload = p
    })
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog open={true} onOpenChange={onOpenChange} onSubmit={onSubmit} isIos={notIos} />,
    )

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  My Agent  ' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: '  https://example.com/acp  ' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Demo' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add agent/i }))
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(payload).toEqual({
      name: 'My Agent',
      url: 'https://example.com/acp',
      description: 'Demo',
      transport: 'http',
    })
    // Closes dialog on success.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows the iOS rejection inline and does NOT call onSubmit', async () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog
        open={true}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        isIos={() => true}
      />,
    )

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'iOS Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'ws://example.com/ws' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add agent/i }))
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/secure/i)
  })

  it('shows an inline error for unsupported schemes and does NOT call onSubmit', async () => {
    const onSubmit = mock(async () => {})
    const onOpenChange = mock(() => {})
    render(
      <AddCustomAgentDialog open={true} onOpenChange={onOpenChange} onSubmit={onSubmit} isIos={notIos} />,
    )

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Bad Agent' } })
    fireEvent.change(screen.getByLabelText(/url/i), { target: { value: 'ftp://example.com' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add agent/i }))
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
