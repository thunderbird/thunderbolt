/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useReducer } from 'react'
import { MemoryRouter } from 'react-router'
import { createPreviewState } from '../data'
import { previewReducer } from '../use-admin-preview-state'
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
  it('gives Thunderbolt read-only resource links without company identity or grants', () => {
    render(<Harness builtIn />)
    expect(screen.getByText('Brand voice')).toBeInTheDocument()
    expect(screen.queryByLabelText('ACP URL')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Brand voice/ })).toHaveAttribute(
      'href',
      '/admin/thunderbolt/skills?edit=brand-voice',
    )
    fireEvent.click(screen.getByText('Connections', { selector: 'button' }))
    expect(screen.getByText('No company connections yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage connections' })).toHaveAttribute('href', '/admin/thunderbolt/mcp')
    fireEvent.click(screen.getByText('Models', { selector: 'button' }))
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage models' })).toHaveAttribute('href', '/admin/thunderbolt/models')
    expect(screen.queryByText('Standard')).not.toBeInTheDocument()
  })
  it('shows saved endpoint wiring as read-only and excludes it from the member preview', () => {
    render(<Harness />)
    expect(screen.getByLabelText('ACP URL')).toHaveValue('wss://agents.demo.thunderbolt/sales')
    expect(screen.getByText('sales-mcp')).toBeInTheDocument()
    expect(screen.getByText('search_sales')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sales desk' } })
    fireEvent.click(screen.getByText('Preview', { selector: 'button' }))
    expect(screen.getByText('Sales desk')).toBeInTheDocument()
    expect(screen.getByText('Sales knowledge base')).toBeInTheDocument()
    expect(screen.queryByText('sales-mcp')).not.toBeInTheDocument()
    expect(screen.queryByText('search_sales')).not.toBeInTheDocument()
  })
})
