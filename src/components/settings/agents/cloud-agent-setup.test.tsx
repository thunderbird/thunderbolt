/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defaultModelDeepSeekV41Flash } from '@shared/defaults/models'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMockHttpClient } from '@/test-utils/http-client'
import { getClock } from '@/testing-library'
import { getDb } from '@/db/database'
import { createCloudOfflineStore } from '@/cloud-agent/offline'
import { createCloudAgentClient } from '@/cloud-agent/client'
import { CloudAgentSetup } from './cloud-agent-setup'
import { createMcpServer } from '@/dal/mcp-servers'
import { createModel } from '@/dal/models'

beforeAll(setupTestDatabase)
beforeEach(resetTestDatabase)
const setupProvider = () => {
  const Provider = createTestProvider()
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <Provider>{children}</Provider>
    </MemoryRouter>
  )
}
afterEach(cleanup)
afterAll(teardownTestDatabase)

it('creates an enabled unlimited agent from the shared purpose-first flow without policy fields', async () => {
  const model = defaultModelDeepSeekV41Flash
  await createModel(getDb(), model)
  await createModel(getDb(), {
    ...model,
    id: 'alternative-model',
    name: 'Alternative model',
    provider: 'custom',
    url: 'http://localhost:11434/v1',
    model: 'alternative-model',
  })
  const client = createCloudAgentClient(createMockHttpClient(), 'owner', createCloudOfflineStore(getDb(), 'owner'))
  const prepare = spyOn(client, 'prepareAgent').mockRejectedValue(new Error('Prepared for verification'))
  render(
    <CloudAgentSetup
      client={client}
      managedModel={{ provider: 'managed', modelId: model.model, contextWindow: 32768, maxOutputTokens: 4096 }}
      connections={[]}
      onCancel={() => {}}
      onSaved={() => {}}
      suggestSetup={async () => ({
        name: 'Code Reviewer',
        systemPrompt: 'Review changes carefully.',
        environment: 'sandbox',
        models: [],
        connections: [],
        skills: [],
      })}
    />,
    { wrapper: setupProvider() },
  )
  expect(screen.queryByLabelText('Enabled')).toBeNull()
  expect(screen.queryByLabelText('Tool approvals')).toBeNull()
  expect(screen.queryByLabelText('Maximum steps')).toBeNull()
  expect(screen.queryByLabelText('Run budget (USD)')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review code' }))
  expect(screen.getByRole('textbox', { name: 'What will this agent do?' })).toHaveValue(
    'Review pull requests for bugs, security issues, and maintainability.',
  )
  await act(async () => {
    await getClock().runAllAsync()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Code Reviewer')
  expect(screen.getByRole('switch', { name: `Use ${model.name}` })).toBeChecked()
  fireEvent.click(screen.getByRole('switch', { name: 'Use Alternative model' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({
    name: 'Code Reviewer',
    instructions: 'Review changes carefully.',
    maxSteps: null,
    maxRunCostUsd: null,
    approvalMode: 'ask',
    localModelId: model.id,
  })
  expect(prepare.mock.calls[0][0].models?.map((entry) => entry.localModelId)).toEqual([model.id, 'alternative-model'])
  expect(prepare.mock.calls[0]?.[2]).toBe(true)
})

it('allows a library model and local MCP without cloud authorization and saves portable references', async () => {
  await createMcpServer(getDb(), { id: 'local-mcp', name: 'Local files', type: 'stdio', enabled: 1 })
  const model = {
    ...defaultModelDeepSeekV41Flash,
    id: 'local-model',
    name: 'Local model',
    provider: 'custom' as const,
    isSystem: 0,
    model: 'local-model',
    url: 'http://localhost:11434/v1',
  }
  await createModel(getDb(), model)
  const client = createCloudAgentClient(createMockHttpClient(), 'owner', createCloudOfflineStore(getDb(), 'owner'))
  const prepare = spyOn(client, 'prepareAgent').mockRejectedValue(new Error('Prepared for verification'))
  render(
    <CloudAgentSetup
      client={client}
      managedModel={null}
      connections={[]}
      onCancel={() => {}}
      onSaved={() => {}}
      suggestSetup={async () => ({
        name: 'Local helper',
        systemPrompt: 'Help with files.',
        environment: 'sandbox',
        models: [],
        connections: [],
        skills: [],
      })}
    />,
    { wrapper: setupProvider() },
  )
  expect(screen.queryByText('Cloud')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Find jobs' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  const modelSwitch = screen.getByRole('switch', { name: `Use ${model.name}` })
  expect(modelSwitch).not.toBeDisabled()
  if (modelSwitch.getAttribute('aria-checked') !== 'true') {
    fireEvent.click(modelSwitch)
  }
  fireEvent.click(screen.getByRole('button', { name: /Connections/ }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  const mcpSwitch = screen.getByRole('switch', { name: 'Local files' })
  expect(mcpSwitch).not.toBeDisabled()
  fireEvent.click(mcpSwitch)
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({
    localModelId: model.id,
    model: null,
    mcpServers: [{ sourceId: 'local-mcp', name: 'Local files' }],
    connectionIds: [],
  })
})
