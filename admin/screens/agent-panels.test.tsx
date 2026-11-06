/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useReducer } from 'react'
import { MemoryRouter } from 'react-router'
import { createPreviewState } from '../data'
import { previewReducer, type PreviewAction, type AdminPreview } from '../use-admin-preview-state'
import { AgentEditor } from './agent-editor'
import { ThunderboltAgentPanel } from './thunderbolt-agent-panel'

const Harness = ({ builtIn = false }: { builtIn?: boolean }) => {
  const [state, dispatch] = useReducer(previewReducer, undefined, createPreviewState)
  const preview = {
    state,
    dispatch,
    agents: state.agents,
    members: state.members,
    groups: state.groups,
    companyModels: state.companyModels.filter((item) => item.deletedAt === null),
    companyMcpServers: state.companyMcpServers,
    companySkills: state.companySkills.filter((skill) => skill.deletedAt === null),
  }
  return builtIn ? (
    <MemoryRouter>
      <ThunderboltAgentPanel preview={preview} onClose={() => {}} />
    </MemoryRouter>
  ) : (
    <AgentEditor agent={state.agents[0]} preview={preview} onClose={() => {}} />
  )
}
afterEach(cleanup)

describe('source design agent panels', () => {
  it('shows Thunderbolt resources in the shared What it uses summary without tabs', () => {
    render(<Harness builtIn />)
    expect(screen.getByRole('heading', { name: 'What it uses' })).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('ACP URL')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '2 skills' })).toHaveAttribute('href', '/admin/thunderbolt/skills')
    expect(screen.getByRole('link', { name: '0 connections' })).toHaveAttribute('href', '/admin/thunderbolt/mcp')
    expect(screen.getByRole('link', { name: '0 models' })).toHaveAttribute('href', '/admin/thunderbolt/models')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
  it('keeps editable details separate from a single read-only capabilities tab', () => {
    render(<Harness />)
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('radio', { name: 'Details' })).toBeChecked()
    expect(screen.getByLabelText('ACP URL')).toHaveValue('wss://agents.demo.thunderbolt/sales')
    expect(screen.queryByRole('combobox', { name: 'Access level' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Groups with access' })).toBeInTheDocument()
    expect(screen.queryByText('Sales knowledge base')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sales desk' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Capabilities' }))
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('ACP URL')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Access level' })).not.toBeInTheDocument()
    expect(screen.getByText('Sales knowledge base')).toBeInTheDocument()
    expect(screen.getByText('read')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'Models' })).toHaveLength(1)
    expect(screen.queryByText('sales-mcp')).not.toBeInTheDocument()
    expect(screen.queryByText('search_sales')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(screen.getByRole('status')).toHaveTextContent('Sample connection successful')
    fireEvent.click(screen.getByRole('radio', { name: 'Details' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Sales desk')
  })
})

const setupAgentEditor = () => {
  const state = createPreviewState()
  const agent = state.agents[0]
  const dispatch = mock((_action: PreviewAction) => {})
  const preview: AdminPreview = { ...state, state, dispatch }
  render(<AgentEditor agent={agent} preview={preview} onClose={() => {}} />)
  return { agent, dispatch }
}

it('saves configuration and group grants together after switching tabs', () => {
  const { agent, dispatch } = setupAgentEditor()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sales desk' } })
  fireEvent.click(screen.getByRole('button', { name: /Groups/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Engineering' }))
  fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search groups' }), { key: 'Escape' })
  expect(dispatch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: 'Capabilities' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Details' }))
  expect(screen.getByRole('button', { name: 'Revoke access for Engineering' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(dispatch).toHaveBeenCalledWith({
    type: 'save-agent',
    agent: { ...agent, name: 'Sales desk', groupIds: ['sales', 'engineering'] },
  })
})

it('discards revoked group grants and saves an empty selection without granting access', () => {
  const { dispatch } = setupAgentEditor()
  expect(screen.queryByRole('button', { name: 'Individuals' })).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Access level' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Sales' }))
  expect(screen.getByText('Assign a group to give its members access to this agent.')).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect(screen.getByRole('button', { name: 'Revoke access for Sales' })).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Sales' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(dispatch).toHaveBeenCalledWith({
    type: 'save-agent',
    agent: expect.objectContaining({ groupIds: [] }),
  })
})

it.each(['wss://agents.demo.thunderbolt/finance', 'wss://agents.example/new'])(
  'refreshes endpoint-owned features when saving %s',
  (url) => {
    const { agent, dispatch } = setupAgentEditor()
    fireEvent.change(screen.getByLabelText('ACP URL'), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const saved = dispatch.mock.calls.at(-1)?.[0]
    expect(saved?.type).toBe('save-agent')
    if (saved?.type !== 'save-agent') throw new Error('Expected an agent save')
    expect(saved.agent.id).toBe(agent.id)
    expect(saved.agent.groupIds).toEqual(agent.groupIds)
    expect(saved.agent.integrations).not.toContain('Salesforce')
    if (url.endsWith('/new')) {
      expect(saved.agent.advertisedModels).toEqual([])
      expect(saved.agent.capabilities).toEqual([])
      expect(saved.agent.modes).toEqual([])
      expect(saved.agent.agentSkillCount).toBe(0)
    } else {
      expect(saved.agent.mcpKinds).toContain('Finance knowledge base')
    }
  },
)
