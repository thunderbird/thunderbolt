/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'

import type { Agent } from '@/types/acp'
import { AgentDetail } from './agent-detail'

const customAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'My Agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.com/ws',
  description: 'A test agent',
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
  ...overrides,
})

const noopHandlers = {
  onClose: () => {},
  onRemoved: () => {},
  onUpdate: async () => {},
  onDelete: async () => {},
}

const renderDetail = (agent: Agent, overrides: Partial<Parameters<typeof AgentDetail>[0]> = {}) =>
  render(<AgentDetail agent={agent} currentUserId="user-1" {...noopHandlers} {...overrides} />)

afterEach(() => {
  cleanup()
})

describe('AgentDetail — system agents', () => {
  it('renders read-only info with no management affordances', () => {
    renderDetail(customAgent({ isSystem: 1, userId: null }))

    expect(screen.getByRole('heading', { name: 'My Agent' })).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText(/managed by your deployment/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})

describe('AgentDetail — custom agents', () => {
  it('is read-only when the agent belongs to a different user', () => {
    renderDetail(customAgent({ userId: 'someone-else' }))

    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    // Values still render as plain text.
    expect(screen.getByText('wss://example.com/ws')).toBeInTheDocument()
  })

  it('saves a renamed agent through onUpdate', async () => {
    const onUpdate = mock(async () => {})
    renderDetail(customAgent(), { onUpdate })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed Agent' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(onUpdate).toHaveBeenCalledWith({ name: 'Renamed Agent' })
  })

  it('re-infers the transport when the endpoint is saved', async () => {
    const onUpdate = mock(async () => {})
    renderDetail(customAgent(), { onUpdate })

    const irohTarget = 'a'.repeat(52)
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: irohTarget } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(onUpdate).toHaveBeenCalledWith({ url: irohTarget, transport: 'iroh' })
  })

  it('blocks saving an invalid endpoint and shows the validation error', () => {
    const onUpdate = mock(async () => {})
    renderDetail(customAgent(), { onUpdate })

    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'http://example.com' } })

    expect(screen.getByText(/wss:\/\//i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('discards a dirty draft back to the stored value', () => {
    renderDetail(customAgent())

    const nameInput = screen.getByLabelText('Name')
    fireEvent.change(nameInput, { target: { value: 'Scratch that' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(nameInput).toHaveValue('My Agent')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('clears the description by saving null', async () => {
    const onUpdate = mock(async () => {})
    renderDetail(customAgent(), { onUpdate })

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(onUpdate).toHaveBeenCalledWith({ description: null })
  })

  it('toggles enabled through onUpdate', () => {
    const onUpdate = mock(async () => {})
    renderDetail(customAgent(), { onUpdate })

    fireEvent.click(screen.getByRole('switch', { name: 'Disable My Agent' }))

    expect(onUpdate).toHaveBeenCalledWith({ enabled: 0 })
  })

  it('removes the agent behind a confirm dialog, then notifies the parent', async () => {
    const onDelete = mock(async () => {})
    const onRemoved = mock(() => {})
    renderDetail(customAgent(), { onDelete, onRemoved })

    // Radix dropdown triggers open on pointerdown, not click.
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
    })
    const removeItem = await waitForElement(() => screen.queryByRole('menuitem', { name: /remove agent/i }))
    await act(async () => {
      fireEvent.click(removeItem)
      await getClock().runAllAsync()
    })
    const confirmButton = await waitForElement(() => screen.queryByRole('button', { name: 'Remove agent' }))
    await act(async () => {
      fireEvent.click(confirmButton)
    })

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onRemoved).toHaveBeenCalledTimes(1)
  })
})

describe('AgentDetail — connection test', () => {
  it('reports a reachable endpoint', async () => {
    const probe = mock(async () => ({ success: true as const, capabilities: {} }))
    renderDetail(customAgent(), { testAcpConnection: probe })

    expect(screen.getByText('Not tested')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    })

    expect(probe).toHaveBeenCalledWith({ url: 'wss://example.com/ws' })
    expect(screen.getByText(/^Reachable/)).toBeInTheDocument()
  })

  it('reports an unreachable endpoint with the probe error', async () => {
    const probe = mock(async () => ({ success: false as const, error: 'Connection timed out' }))
    renderDetail(customAgent(), { testAcpConnection: probe })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    })

    expect(screen.getByText(/^Unreachable/)).toBeInTheDocument()
    expect(screen.getByText('Connection timed out')).toBeInTheDocument()
  })

  it('skips the probe UI for iroh agents (verified on first chat)', () => {
    renderDetail(customAgent({ transport: 'iroh', url: 'a'.repeat(52) }))

    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument()
    expect(screen.getByText(/peer-to-peer via iroh/i)).toBeInTheDocument()
  })
})
