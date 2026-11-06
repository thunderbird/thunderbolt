/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { AgentList } from './agent-list'
import { agentProvenanceLine } from './agent-provenance'

afterEach(() => {
  cleanup()
})

const systemAgent: Agent = {
  id: 'haystack-rag',
  name: 'RAG Chat',
  type: 'managed-acp',
  transport: 'websocket',
  url: 'wss://thunderbolt.example/v1/haystack/ws',
  description: 'Retrieval-augmented chat',
  icon: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

const customAgent: Agent = {
  id: 'custom-1',
  name: 'My Remote Agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://my.example.com/ws',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-42',
}

const noop = () => {}

describe('agentProvenanceLine', () => {
  it('labels the built-in agent as built into the app', () => {
    expect(agentProvenanceLine(builtInAgent)).toBe('Your agent · built into the app')
  })

  it('labels system agents as always available', () => {
    expect(agentProvenanceLine(systemAgent)).toBe('System agent · always available')
  })

  it('labels custom agents with the endpoint host', () => {
    expect(agentProvenanceLine(customAgent)).toBe('Connected agent · my.example.com')
  })

  it('falls back to a generic label for non-URL (iroh) targets', () => {
    // iroh targets are bare base32 NodeIds / tickets, not parseable URLs.
    expect(agentProvenanceLine({ ...customAgent, transport: 'iroh', url: 'a'.repeat(52) })).toBe(
      'Connected agent · iroh peer',
    )
  })
})

describe('AgentList', () => {
  it('renders every agent as a row with its provenance line', () => {
    render(<AgentList agents={[builtInAgent, systemAgent, customAgent]} onOpenAgent={noop} />)

    expect(screen.getByTestId(`agent-row-${builtInAgent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`agent-row-${systemAgent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`agent-row-${customAgent.id}`)).toBeInTheDocument()

    expect(screen.getByTestId(`agent-provenance-${builtInAgent.id}`)).toHaveTextContent(
      'Your agent · built into the app',
    )
    expect(screen.getByTestId(`agent-provenance-${systemAgent.id}`)).toHaveTextContent(
      'System agent · always available',
    )
    expect(screen.getByTestId(`agent-provenance-${customAgent.id}`)).toHaveTextContent(
      'Connected agent · my.example.com',
    )
  })

  it('splits into "Your agents" and "System agents" sections when system agents exist', () => {
    render(<AgentList agents={[builtInAgent, systemAgent, customAgent]} onOpenAgent={noop} />)

    const yours = screen.getByTestId('agent-section-yours')
    const system = screen.getByTestId('agent-section-system')

    expect(yours).toHaveTextContent('Your agents')
    expect(system).toHaveTextContent('System agents')

    // Built-in + custom live under "Your agents"; the managed agent under "System agents".
    expect(yours.querySelector(`[data-testid="agent-row-${builtInAgent.id}"]`)).not.toBeNull()
    expect(yours.querySelector(`[data-testid="agent-row-${customAgent.id}"]`)).not.toBeNull()
    expect(system.querySelector(`[data-testid="agent-row-${systemAgent.id}"]`)).not.toBeNull()
  })

  it('renders a flat list without section labels when there are no system agents', () => {
    render(<AgentList agents={[builtInAgent, customAgent]} onOpenAgent={noop} />)

    expect(screen.queryByTestId('agent-section-yours')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-section-system')).not.toBeInTheDocument()
    expect(screen.queryByText('Your agents')).not.toBeInTheDocument()
  })

  it('calls onOpenAgent with the agent when a row is clicked', () => {
    const onOpenAgent = mock<(agent: Agent) => void>(() => {})

    render(<AgentList agents={[builtInAgent, customAgent]} onOpenAgent={onOpenAgent} />)

    fireEvent.click(screen.getByRole('button', { name: `Open ${customAgent.name}` }))

    expect(onOpenAgent).toHaveBeenCalledTimes(1)
    expect(onOpenAgent.mock.calls[0][0].id).toBe(customAgent.id)
  })

  it('marks the open row as selected', () => {
    render(<AgentList agents={[builtInAgent, customAgent]} selectedId={customAgent.id} onOpenAgent={noop} />)

    expect(screen.getByRole('button', { name: `Open ${customAgent.name}` })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: `Open ${builtInAgent.name}` })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows a Disabled suffix on disabled custom agents', () => {
    render(<AgentList agents={[{ ...customAgent, enabled: 0 }]} onOpenAgent={noop} />)

    expect(screen.getByTestId(`agent-provenance-${customAgent.id}`)).toHaveTextContent(
      'Connected agent · my.example.com · Disabled',
    )
  })
})
