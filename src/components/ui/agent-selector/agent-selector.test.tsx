/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { AgentSelector, categorizeAgents } from './agent-selector'

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
  description: 'Local-only secret stash',
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-42',
}

afterEach(() => {
  cleanup()
})

describe('categorizeAgents', () => {
  it('produces three groups when every flavor is present, in canonical order', () => {
    const groups = categorizeAgents([builtInAgent, systemAgent, customAgent])

    expect(groups.map((g) => g.id)).toEqual(['built-in', 'system', 'custom'])
    expect(groups[0].items[0].id).toBe(builtInAgent.id)
    expect(groups[1].items[0].id).toBe(systemAgent.id)
    expect(groups[2].items[0].id).toBe(customAgent.id)
  })

  it('drops empty buckets', () => {
    const groups = categorizeAgents([builtInAgent])

    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('built-in')
  })

  it('groups multiple customs into the custom bucket', () => {
    const other: Agent = { ...customAgent, id: 'custom-2', name: 'Another' }
    const groups = categorizeAgents([builtInAgent, customAgent, other])

    const customGroup = groups.find((g) => g.id === 'custom')
    expect(customGroup?.items).toHaveLength(2)
  })
})

describe('AgentSelector', () => {
  it('renders the trigger with the selected agent name', () => {
    const onSelect = mock(() => {})
    render(<AgentSelector selectedAgent={systemAgent} agents={[builtInAgent, systemAgent]} onSelect={onSelect} />)

    const trigger = screen.getByTestId('agent-selector-trigger')
    expect(trigger).toHaveTextContent('RAG Chat')
  })

  it('opens the dropdown and exposes all agents when enabled', () => {
    const onSelect = mock(() => {})
    render(
      <AgentSelector
        selectedAgent={builtInAgent}
        agents={[builtInAgent, systemAgent, customAgent]}
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByTestId('agent-selector-trigger'))

    // Built-in appears in both the trigger and the dropdown item; assert at least one match.
    expect(screen.getAllByText('Thunderbolt').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('RAG Chat')).toBeInTheDocument()
    expect(screen.getByText('My Remote Agent')).toBeInTheDocument()
  })

  it('invokes onSelect with the chosen agent', () => {
    const onSelect = mock<(agent: Agent) => void>(() => {})
    render(
      <AgentSelector
        selectedAgent={builtInAgent}
        agents={[builtInAgent, systemAgent, customAgent]}
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    fireEvent.click(screen.getByText('My Remote Agent'))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe(customAgent.id)
  })

  it('does not open the dropdown while disabled', () => {
    const onSelect = mock(() => {})
    render(
      <AgentSelector selectedAgent={builtInAgent} agents={[builtInAgent, systemAgent]} onSelect={onSelect} disabled />,
    )

    fireEvent.click(screen.getByTestId('agent-selector-trigger'))

    // Dropdown contents are not in the DOM (Popover is closed)
    expect(screen.queryByText('RAG Chat')).not.toBeInTheDocument()
  })

  it('exposes the Add Agent footer that invokes its callback', () => {
    const onSelect = mock(() => {})
    const onAddAgent = mock(() => {})
    render(
      <AgentSelector
        selectedAgent={builtInAgent}
        agents={[builtInAgent]}
        onSelect={onSelect}
        onAddAgent={onAddAgent}
      />,
    )

    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    fireEvent.click(screen.getByText('Add Agent'))

    expect(onAddAgent).toHaveBeenCalledTimes(1)
  })

  it('renders without crashing when only the built-in agent is available', () => {
    const onSelect = mock(() => {})
    render(<AgentSelector selectedAgent={builtInAgent} agents={[builtInAgent]} onSelect={onSelect} />)

    expect(screen.getByTestId('agent-selector-trigger')).toHaveTextContent('Thunderbolt')
  })
})
