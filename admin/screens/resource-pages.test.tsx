/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import { useReducer } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { thunderboltModelCatalog } from '@/settings/models/model-catalog'
import { CompanyModelsPage } from './company-models-page'
import { createPreviewState } from '../data'
import { previewReducer } from '../use-admin-preview-state'
import { CompanySkillsPage } from './company-skills-page'
import { CompanyMcpPage } from './company-mcp-page'
import { ThunderboltAgentPanel } from './thunderbolt-agent-panel'

const ResourceHarness = ({ entry = '/admin' }: { entry?: string }) => {
  const [state, dispatch] = useReducer(previewReducer, undefined, createPreviewState)
  const preview = {
    state,
    dispatch,
    agents: state.agents,
    members: state.members,
    groups: state.groups,
    companySkills: state.companySkills.filter((item) => item.deletedAt === null),
    companyModels: state.companyModels.filter((item) => item.deletedAt === null),
    companyMcpServers: state.companyMcpServers.filter((item) => item.deletedAt === null),
  }
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Link to="/admin">Agent configuration</Link>
      <Routes>
        <Route path="/admin" element={<ThunderboltAgentPanel preview={preview} onClose={() => {}} />} />
        <Route path="/admin/thunderbolt/skills" element={<CompanySkillsPage preview={preview} />} />
        <Route path="/admin/thunderbolt/models" element={<CompanyModelsPage preview={preview} />} />
        <Route path="/admin/thunderbolt/mcp" element={<CompanyMcpPage preview={preview} />} />
      </Routes>
    </MemoryRouter>
  )
}
afterEach(cleanup)

it('opens a read-only skill link in the full native form and reflects saved edits in the agent', async () => {
  render(<ResourceHarness />)
  expect(screen.queryByLabelText('Instructions')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: /Brand voice/ }))
  expect(screen.getByLabelText('Name')).toHaveValue('Brand voice')
  expect(screen.getByLabelText('Slug')).toHaveValue('brand-voice')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Company voice' } })
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Use concise, clear language.' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  fireEvent.click(screen.getByRole('link', { name: 'Agent configuration' }))
  expect(screen.getByRole('link', { name: /Company voice/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: /Company voice/ }))
  expect(screen.getByLabelText('Instructions')).toHaveValue('Use concise, clear language.')
})

it('validates and saves MCP configuration, links back to its editor, and soft-removes it', async () => {
  render(<ResourceHarness />)
  fireEvent.click(screen.getByRole('radio', { name: 'Connections' }))
  fireEvent.click(screen.getByRole('link', { name: 'Manage connections' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add your first server' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team knowledge' } })
  fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'invalid-url' } })
  expect(screen.getByRole('button', { name: 'Add Server' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://example.com/mcp' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add Server' }))
  expect(screen.getByRole('button', { name: 'Open Team knowledge' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('switch', { name: 'Disable Team knowledge' }))
  fireEvent.click(screen.getByRole('link', { name: 'Agent configuration' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Connections' }))
  expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument()
  expect(screen.getByText('Disabled')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: /Team knowledge/ }))
  expect(screen.getByLabelText('Server URL')).toHaveValue('https://example.com/mcp')
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove server' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  fireEvent.click(screen.getByRole('link', { name: 'Agent configuration' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Connections' }))
  expect(screen.queryByRole('link', { name: /Team knowledge/ })).not.toBeInTheDocument()
})

it('rejects duplicate skill slugs and protects an unsaved form when cancelled', async () => {
  render(<ResourceHarness entry="/admin/thunderbolt/skills?edit=new" />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Brand voice' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
    target: { value: 'New description' },
  })
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'New instructions' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  })
  expect(screen.getByText('A skill with this slug already exists.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(screen.getByLabelText('Instructions')).toHaveValue('New instructions')
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-policy' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  })
  expect(screen.queryByLabelText('Instructions')).not.toBeInTheDocument()
})

it('uses the real model picker, persists edits in the summary, and retains the personal-model policy', async () => {
  render(<ResourceHarness />)
  fireEvent.click(screen.getByRole('radio', { name: 'Models' }))
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: 'Manage models' }))
  fireEvent.click(screen.getByRole('button', { name: 'Model settings' }))
  expect(screen.getByRole('switch', { name: 'Personal models' })).toBeChecked()
  fireEvent.click(screen.getByRole('switch', { name: 'Personal models' }))
  expect(screen.getByRole('switch', { name: 'Personal models' })).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Model settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'New Model' }))
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('combobox', { name: 'Model' }))
  const bundled = thunderboltModelCatalog[0]
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name: new RegExp(bundled.name ?? bundled.id) }))
  })
  expect(screen.getByLabelText('Display Name')).toHaveValue(bundled.name)
  await act(async () => {
    fireEvent.click(
      within(screen.getByLabelText('Display Name').closest('form')!).getByRole('button', { name: 'Add Model' }),
    )
  })
  fireEvent.click(screen.getByRole('switch', { name: `Disable ${bundled.name}` }))
  fireEvent.click(screen.getByRole('link', { name: 'Agent configuration' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Models' }))
  expect(screen.getByText('Disabled')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: new RegExp(bundled.name ?? bundled.id) }))
  expect(screen.getByRole('combobox', { name: 'Provider' })).toBeDisabled()
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Team model' } })
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  expect(screen.getByRole('button', { name: 'Open Team model' })).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Enable Team model' })).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Open Team model' }))
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove model' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(screen.queryByRole('button', { name: 'Open Team model' })).not.toBeInTheDocument()
})
