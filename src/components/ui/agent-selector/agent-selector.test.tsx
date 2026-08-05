/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import type { Agent } from '@/types/acp'
import { AgentSelector, buildAgentItems } from './agent-selector'

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
  restoreViewport()
})

describe('buildAgentItems', () => {
  it('flattens every flavor into one list in canonical order', () => {
    const items = buildAgentItems([customAgent, systemAgent, builtInAgent])

    expect(items.map((i) => i.id)).toEqual([builtInAgent.id, systemAgent.id, customAgent.id])
  })

  it('keeps multiple customs after built-in and system agents', () => {
    const other: Agent = { ...customAgent, id: 'custom-2', name: 'Another' }
    const items = buildAgentItems([builtInAgent, customAgent, other])

    expect(items.map((i) => i.id)).toEqual([builtInAgent.id, customAgent.id, 'custom-2'])
  })
})

describe('AgentSelector', () => {
  it('renders the trigger with the selected agent name', () => {
    const onSelect = mock(() => {})
    render(<AgentSelector selectedAgent={systemAgent} agents={[builtInAgent, systemAgent]} onSelect={onSelect} />)

    const trigger = screen.getByTestId('agent-selector-trigger')
    expect(trigger).toHaveTextContent('RAG Chat')
    expect(trigger).toHaveClass('max-md:h-[var(--touch-height-lg)]')
    expect(screen.getByTestId('agent-selector-pill')).toHaveClass(
      'px-4',
      'md:px-3',
      'max-md:bg-muted/80',
      'max-md:dark:bg-muted/40',
      'max-md:backdrop-blur-md',
    )
  })

  it('gives the collapsed mobile control the shared frosted background', () => {
    const onSelect = mock(() => {})
    render(
      <AgentSelector selectedAgent={systemAgent} agents={[builtInAgent, systemAgent]} onSelect={onSelect} collapsed />,
    )

    expect(screen.getByTestId('agent-selector-collapsed-circle')).toHaveClass(
      'max-md:bg-muted/80',
      'max-md:backdrop-blur-md',
    )
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
    const trigger = screen.getByTestId('agent-selector-trigger').closest('button')
    fireEvent.click(screen.getByText('Add Agent'))

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(onAddAgent).toHaveBeenCalledTimes(1)
  })

  it('closes the mobile agent drawer before invoking Add Agent', () => {
    forceMobileViewport()
    const onAddAgent = mock(() => {})
    render(
      <AgentSelector
        selectedAgent={builtInAgent}
        agents={[builtInAgent]}
        onSelect={() => {}}
        onAddAgent={onAddAgent}
      />,
    )

    const trigger = screen.getByTestId('agent-selector-trigger').closest('button')
    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull()
    fireEvent.click(screen.getByText('Add Agent'))

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // The mobile card drawer must be gone before the add flow opens.
    expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull()
    expect(onAddAgent).toHaveBeenCalledTimes(1)
  })

  it('renders without crashing when only the built-in agent is available', () => {
    const onSelect = mock(() => {})
    render(<AgentSelector selectedAgent={builtInAgent} agents={[builtInAgent]} onSelect={onSelect} />)

    expect(screen.getByTestId('agent-selector-trigger')).toHaveTextContent('Thunderbolt')
  })
})
