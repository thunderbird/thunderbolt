/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { AgentList } from './agent-list'
import { agentToggleDisabled, canDeleteAgent, canEditAgent } from './agent-row'

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

describe('canDeleteAgent', () => {
  it('returns false for the built-in agent', () => {
    expect(canDeleteAgent(builtInAgent, 'user-42')).toBe(false)
  })

  it('returns false for system agents', () => {
    expect(canDeleteAgent(systemAgent, 'user-42')).toBe(false)
  })

  it('returns true for customs owned by the current user', () => {
    expect(canDeleteAgent(customAgent, 'user-42')).toBe(true)
  })

  it('returns false for customs owned by a different user', () => {
    expect(canDeleteAgent(customAgent, 'someone-else')).toBe(false)
  })

  it('returns false when no user is signed in', () => {
    expect(canDeleteAgent(customAgent, null)).toBe(false)
  })

  it('returns false when the workspace `remove_agents` permission denies the user', () => {
    expect(canDeleteAgent(customAgent, 'user-42', false)).toBe(false)
  })

  it('returns true when canRemoveAgents defaults (omitted), preserving prior behaviour', () => {
    expect(canDeleteAgent(customAgent, 'user-42')).toBe(true)
  })
})

describe('canEditAgent', () => {
  it('mirrors canDeleteAgent — built-in and system are non-editable, customs are owned by the user', () => {
    expect(canEditAgent(builtInAgent, 'user-42')).toBe(false)
    expect(canEditAgent(systemAgent, 'user-42')).toBe(false)
    expect(canEditAgent(customAgent, 'user-42')).toBe(true)
    expect(canEditAgent(customAgent, 'someone-else')).toBe(false)
    expect(canEditAgent(customAgent, null)).toBe(false)
  })
})

describe('AgentList', () => {
  it('renders rows for built-in, system, and custom agents in the given order', () => {
    render(
      <AgentList
        agents={[builtInAgent, systemAgent, customAgent]}
        currentUserId="user-42"
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    )

    expect(screen.getByTestId(`agent-row-${builtInAgent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`agent-row-${systemAgent.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`agent-row-${customAgent.id}`)).toBeInTheDocument()

    expect(screen.getByTestId(`agent-badge-${builtInAgent.id}`)).toHaveTextContent('Built-in')
    expect(screen.getByTestId(`agent-badge-${systemAgent.id}`)).toHaveTextContent('System')
    expect(screen.getByTestId(`agent-badge-${customAgent.id}`)).toHaveTextContent('Remote')
  })

  it('only renders the delete button on custom agents owned by the user', () => {
    render(
      <AgentList
        agents={[builtInAgent, systemAgent, customAgent]}
        currentUserId="user-42"
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    )

    expect(screen.queryByTestId(`agent-delete-${builtInAgent.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`agent-delete-${systemAgent.id}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`agent-delete-${customAgent.id}`)).toBeInTheDocument()
  })

  it('only renders the edit button on custom agents owned by the user', () => {
    render(
      <AgentList
        agents={[builtInAgent, systemAgent, customAgent]}
        currentUserId="user-42"
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    )

    expect(screen.queryByTestId(`agent-edit-${builtInAgent.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`agent-edit-${systemAgent.id}`)).not.toBeInTheDocument()
    expect(screen.getByTestId(`agent-edit-${customAgent.id}`)).toBeInTheDocument()
  })

  it('calls onEdit with the agent when the edit button is clicked', () => {
    const onEdit = mock<(agent: Agent) => void>(() => {})

    render(<AgentList agents={[customAgent]} currentUserId="user-42" onToggle={noop} onEdit={onEdit} onDelete={noop} />)

    fireEvent.click(screen.getByTestId(`agent-edit-${customAgent.id}`))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit.mock.calls[0][0].id).toBe(customAgent.id)
  })

  it('calls onToggle with the new enabled value when a custom agent toggle flips', () => {
    const onToggle = mock<(agent: Agent, enabled: boolean) => void>(() => {})

    render(
      <AgentList agents={[customAgent]} currentUserId="user-42" onToggle={onToggle} onEdit={noop} onDelete={noop} />,
    )

    const toggle = screen.getByTestId(`agent-toggle-${customAgent.id}`)
    fireEvent.click(toggle)

    expect(onToggle).toHaveBeenCalledTimes(1)
    const [agentArg, enabledArg] = onToggle.mock.calls[0]
    expect(agentArg.id).toBe(customAgent.id)
    expect(enabledArg).toBe(false)
  })

  it('disables the toggle for the built-in agent', () => {
    render(<AgentList agents={[builtInAgent]} currentUserId="user-42" onToggle={noop} onEdit={noop} onDelete={noop} />)

    expect(screen.getByTestId(`agent-toggle-${builtInAgent.id}`)).toBeDisabled()
  })

  it('disables the toggle for system agents', () => {
    render(<AgentList agents={[systemAgent]} currentUserId="user-42" onToggle={noop} onEdit={noop} onDelete={noop} />)

    expect(screen.getByTestId(`agent-toggle-${systemAgent.id}`)).toBeDisabled()
  })

  it('keeps the toggle enabled for custom agents', () => {
    render(<AgentList agents={[customAgent]} currentUserId="user-42" onToggle={noop} onEdit={noop} onDelete={noop} />)

    expect(screen.getByTestId(`agent-toggle-${customAgent.id}`)).not.toBeDisabled()
  })

  it('hides the Remove affordance on every row when canRemoveAgents is false', () => {
    const onToggle = mock(() => {})
    const onDelete = mock(() => {})

    render(
      <AgentList
        agents={[customAgent]}
        currentUserId="user-42"
        canRemoveAgents={false}
        onToggle={onToggle}
        onDelete={onDelete}
      />,
    )

    expect(screen.queryByTestId(`agent-delete-${customAgent.id}`)).not.toBeInTheDocument()
  })

  it('disables the row toggle when canEditAgents is false (even for an owned custom)', () => {
    const onToggle = mock(() => {})
    const onDelete = mock(() => {})

    render(
      <AgentList
        agents={[customAgent]}
        currentUserId="user-42"
        canEditAgents={false}
        onToggle={onToggle}
        onDelete={onDelete}
      />,
    )

    expect(screen.getByTestId(`agent-toggle-${customAgent.id}`)).toBeDisabled()
  })
})

describe('agentToggleDisabled', () => {
  it('disables the toggle for the built-in agent with the built-in tooltip', () => {
    expect(agentToggleDisabled(builtInAgent)).toEqual({
      disabled: true,
      disabledTooltip: 'Built-in agent is always available',
    })
  })

  it('disables the toggle for system agents with the system tooltip', () => {
    expect(agentToggleDisabled(systemAgent)).toEqual({
      disabled: true,
      disabledTooltip: 'System agent is always available',
    })
  })

  it('keeps the toggle enabled for custom agents and emits no tooltip', () => {
    expect(agentToggleDisabled(customAgent)).toEqual({
      disabled: false,
      disabledTooltip: null,
    })
  })
})
