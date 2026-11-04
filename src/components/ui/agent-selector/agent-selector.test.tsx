/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import { agentInEnvironment } from '@/cloud-agent/agent-inventory'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import type { Agent, CloudAgent } from '@/types/acp'
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

const cloudAgent: CloudAgent = {
  ...customAgent,
  id: 'cloud:00000000-0000-4000-8000-000000000001',
  cloudAgentId: '00000000-0000-4000-8000-000000000001',
  name: 'My Cloud Assistant',
  type: 'cloud',
  transport: 'http',
  url: null,
  isSystem: 0,
  userId: 'user-42',
}

afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('buildAgentItems', () => {
  it('includes cloud summaries but excludes disabled and deleted agents', () => {
    const items = buildAgentItems([
      builtInAgent,
      cloudAgent,
      { ...customAgent, enabled: 0 },
      { ...cloudAgent, id: 'deleted-cloud', deletedAt: '2026-10-23' },
    ])
    expect(items.map((item) => item.id)).toEqual([builtInAgent.id, cloudAgent.id])
  })

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
  it('shows one definition while preserving the chosen local runtime on selection', () => {
    const select = mock<(agent: Agent) => void>(() => {})
    const local = agentInEnvironment(cloudAgent, 'local')
    render(<AgentSelector selectedAgent={local} agents={[builtInAgent, cloudAgent]} onSelect={select} />)
    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    const rows = screen.getAllByText('My Cloud Assistant')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      id: local.id,
      cloudAgentId: cloudAgent.cloudAgentId,
      executionEnvironment: 'local',
    })
  })
  it('selects a cloud agent through the ordinary composer menu', () => {
    const select = mock<(agent: Agent) => void>(() => {})
    render(<AgentSelector selectedAgent={builtInAgent} agents={[builtInAgent, cloudAgent]} onSelect={select} />)
    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    fireEvent.click(screen.getByText('My Cloud Assistant'))
    expect(select.mock.calls[0]?.[0]).toBe(cloudAgent)
  })

  it('keeps a disabled selected cloud label while offering only available replacements', () => {
    const select = mock<(agent: Agent) => void>(() => {})
    const disabled = { ...cloudAgent, enabled: 0 as const }
    render(<AgentSelector selectedAgent={disabled} agents={[builtInAgent, disabled]} onSelect={select} />)
    expect(screen.getByTestId('agent-selector-trigger')).toHaveTextContent(cloudAgent.name)
    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    expect(screen.getAllByText(cloudAgent.name)).toHaveLength(1)
    fireEvent.click(screen.getByText('Thunderbolt'))
    expect(select.mock.calls[0]?.[0]).toBe(builtInAgent)
  })

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

  it('opens settings without selecting the agent and closes the menu first', () => {
    const onSelect = mock(() => {})
    const onEditAgent = mock(() => {})
    render(
      <AgentSelector
        selectedAgent={builtInAgent}
        agents={[builtInAgent, cloudAgent]}
        onSelect={onSelect}
        onEditAgent={onEditAgent}
      />,
    )
    fireEvent.click(screen.getByTestId('agent-selector-trigger'))
    const settings = screen.getByRole('button', { name: 'Settings for My Cloud Assistant' })
    expect(settings.parentElement?.closest('button')).toBeNull()
    fireEvent.click(settings)
    expect(onEditAgent).toHaveBeenCalledWith(cloudAgent)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-selector-trigger').closest('button')).toHaveAttribute('aria-expanded', 'false')
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

  it('closes the mobile agent drawer when invoking Add Agent', async () => {
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
    expect(onAddAgent).toHaveBeenCalledTimes(1)
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull()
  })

  it('is a plain label, with no menu, when there is one agent and no way to add another', () => {
    render(<AgentSelector selectedAgent={builtInAgent} agents={[builtInAgent]} onSelect={() => {}} disabled />)

    const trigger = screen.getByTestId('agent-selector-trigger')
    expect(trigger).toHaveTextContent('Thunderbolt')
    expect(trigger.closest('button')).toBeNull()
    // Not dimmed by `disabled`: there is no switch to hold back during a reply.
    expect(trigger).not.toHaveClass('opacity-60')

    fireEvent.click(trigger)

    expect(screen.getAllByText('Thunderbolt')).toHaveLength(1)
  })

  describe('when the only available agent is not the selected one', () => {
    // A chat created before hosted-agent discovery finished keeps the built-in
    // fallback, so the hosted agent is the one choice and must stay reachable.
    const openAndPick = () => {
      const onSelect = mock()
      render(<AgentSelector selectedAgent={builtInAgent} agents={[systemAgent]} onSelect={onSelect} />)
      fireEvent.click(screen.getByTestId('agent-selector-trigger'))
      return onSelect
    }

    it('keeps the menu', () => {
      const onSelect = openAndPick()

      fireEvent.click(screen.getByText('RAG Chat'))
      expect(onSelect).toHaveBeenCalledWith(systemAgent)
    })
  })
})
