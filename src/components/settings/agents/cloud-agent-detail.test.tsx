/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { agentModels, agentModelPatch } from '@shared/cloud-agent/agent-models'
import { defaultModelDeepSeekV41Flash } from '@shared/defaults/models'
import { createModel } from '@/dal/models'
import { MemoryRouter } from 'react-router'
import type { CloudModel, SaveCloudAgent } from '@shared/cloud-agent/contracts'
import { createCloudAgentClient, type CloudAgentClient, type CloudAgentView } from '@/cloud-agent/client'
import { createCloudOfflineStore } from '@/cloud-agent/offline'
import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { CloudAgentDetail, type AgentDetailView } from './cloud-agent-detail'

const managedModel: CloudModel = {
  provider: 'managed',
  modelId: 'managed-test-model',
  contextWindow: 32768,
  maxOutputTokens: 4096,
}

const agentFixture = (enabled: boolean): CloudAgentView => ({
  record: {
    id: 'agent',
    ownerId: 'owner',
    version: 7,
    keyEpoch: 1,
    enabled,
    config: { version: 1, kind: 'scoped-payload', iv: 'opaque', ciphertext: 'opaque' },
    ownerKeyEnvelope: {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: 'owner',
      ephemeralPublicKey: 'opaque',
      mlkemCiphertext: 'opaque',
      iv: 'opaque',
      ciphertext: 'opaque',
    },
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    deletedAt: null,
  },
  config: {
    ownerRecipient: { version: 1, keyId: 'owner', ecdhPublicKey: 'opaque', mlkemPublicKey: 'opaque' },
    name: 'Research assistant',
    description: '',
    instructions: 'Original instructions',
    model: managedModel,
    skills: [],
    connectionIds: [],
    searchEnabled: false,
    approvalMode: 'ask',
    maxSteps: 30,
    maxRunCostUsd: 1,
  },
})

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

const renderDetail = (client: CloudAgentClient, initialAgent: CloudAgentView) => {
  const Detail = () => {
    const [agent, setAgent] = useState(initialAgent)
    const [view, setView] = useState<AgentDetailView>('settings')
    return (
      <MemoryRouter>
        <CloudAgentDetail
          client={client}
          agent={agent}
          connections={[]}
          managedModel={managedModel}
          view={view}
          onViewChange={setView}
          onClose={() => {}}
          onSaved={setAgent}
        />
      </MemoryRouter>
    )
  }
  return render(<Detail />, { wrapper: createTestProvider() })
}

const editorClient = (agent: CloudAgentView) => {
  const client = createCloudAgentClient(createMockHttpClient(), 'owner', createCloudOfflineStore(getDb(), 'owner'))
  const preparedViews = new Map<SaveCloudAgent, CloudAgentView>()
  const prepare = spyOn(client, 'prepareAgent').mockImplementation(async (config, previous, enabled = true) => {
    const record = previous ?? agent.record
    const command: SaveCloudAgent = {
      id: record.id,
      expectedVersion: record.version,
      keyEpoch: record.keyEpoch,
      enabled,
      config: record.config,
      ownerKeyEnvelope: record.ownerKeyEnvelope,
      runtimeKeyEnvelope: record.ownerKeyEnvelope,
    }
    preparedViews.set(command, {
      record: { ...record, version: record.version + 1, enabled },
      config: { ...config, ownerRecipient: agent.config.ownerRecipient },
    })
    return command
  })
  const submit = spyOn(client, 'submitAgent').mockImplementation(async (command) => {
    const saved = preparedViews.get(command)
    if (!saved) {
      throw new Error('Unknown prepared command')
    }
    return saved
  })
  const autosave = spyOn(client, 'saveAgent').mockResolvedValue({
    ...agent,
    record: { ...agent.record, version: agent.record.version + 1, enabled: !agent.record.enabled },
  })
  return { client, prepare, submit, autosave }
}

describe('cloud agent settings save', () => {
  beforeAll(setupTestDatabase)
  beforeEach(resetTestDatabase)
  afterEach(cleanup)
  afterAll(teardownTestDatabase)

  it('keeps an emoji selection in the draft until Save and supports clearing it', async () => {
    const agent = agentFixture(true)
    const transport = editorClient(agent)
    renderDetail(transport.client, agent)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Choose an icon for Research assistant' }))
    fireEvent.click(screen.getByRole('button', { name: '📊' }))
    expect(screen.getByRole('button', { name: 'Choose an icon for Research assistant' })).toHaveTextContent('📊')
    expect(transport.prepare).not.toHaveBeenCalled()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare.mock.calls[0][0].icon).toBe('📊')
    expect(screen.getByRole('button', { name: 'Choose an icon for Research assistant' })).toHaveTextContent('📊')

    fireEvent.click(screen.getByRole('button', { name: 'Choose an icon for Research assistant' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove icon' }))
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare.mock.calls[1][0].icon).toBeNull()
  })

  it('blocks saving with no enabled models and restores saving when one is enabled', async () => {
    await createModel(getDb(), defaultModelDeepSeekV41Flash)
    const agent = agentFixture(true)
    const transport = editorClient(agent)
    renderDetail(transport.client, agent)
    await flush()

    const modelSwitch = screen.getByRole('switch', { name: 'Use managed-test-model' })
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    fireEvent.click(modelSwitch)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByText('Default')).toBeNull()
    expect(screen.getByText('At least one model required')).toBeInTheDocument()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('switch', { name: /^Use / })[0])
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    expect(screen.getByText('Default')).toBeInTheDocument()
  })

  it('keeps settings and schedules in the aside without a separate conversation surface', async () => {
    const agent = agentFixture(true)
    const transport = editorClient(agent)
    const conversations = spyOn(transport.client, 'conversations').mockResolvedValue([])
    const schedules = spyOn(transport.client, 'getSchedules').mockResolvedValue([])
    renderDetail(transport.client, agent)
    await flush()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Schedules' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Conversations' })).toBeNull()
    expect(screen.queryByText('Environment')).toBeNull()
    expect(screen.getByText('Thunderbolt agent')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Schedules' }))
    await act(async () => {
      await getClock().tickAsync(50)
    })
    expect(schedules).toHaveBeenCalledTimes(1)
    expect(conversations).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add schedule' })).toBeInTheDocument()
  })

  it('saves settings against the latest version while preserving activation from the list', async () => {
    const agent = agentFixture(true)
    const transport = editorClient(agent)
    renderDetail(transport.client, agent)
    await flush()

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Edited assistant' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Updated instructions before disabling' },
    })
    await flush()

    expect(transport.autosave).not.toHaveBeenCalled()
    expect(transport.prepare).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Edited assistant')
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Updated instructions before disabling')
    expect(screen.queryByRole('switch', { name: 'Enable Edited assistant' })).toBeNull()

    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare).toHaveBeenCalledTimes(1)
    expect(transport.prepare.mock.calls[0]).toEqual([
      {
        ...agent.config,
        ...agentModelPatch(agentModels(agent.config)),
        mcpServers: [],
        name: 'Edited assistant',
        instructions: 'Updated instructions before disabling',
      },
      agent.record,
      true,
    ])
    expect(transport.submit.mock.calls[0][0]).toMatchObject({ expectedVersion: 7, enabled: true })
    expect(screen.queryByRole('switch', { name: 'Enable Edited assistant' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Current instructions before enabling' },
    })
    expect(transport.submit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare.mock.calls[1][0]).toMatchObject({
      name: 'Edited assistant',
      instructions: 'Current instructions before enabling',
    })
    expect(transport.submit.mock.calls[1][0]).toMatchObject({ expectedVersion: 8, enabled: true })
    expect(transport.autosave).not.toHaveBeenCalled()
  })

  it('saves model order, promotes the next model when disabled, and prevents saving an empty selection', async () => {
    const agent = agentFixture(true)
    const models = [
      { localModelId: 'a', name: 'Model A', model: managedModel },
      { localModelId: 'b', name: 'Model B', model: null },
    ]
    agent.config = { ...agent.config, ...agentModelPatch([models[1], models[0]]) }
    const transport = editorClient(agent)
    renderDetail(transport.client, agent)
    await flush()
    expect(screen.getByRole('button', { name: 'Reorder Model B' })).toBeInTheDocument()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare.mock.calls[0][0]).toMatchObject({
      models: [models[1], models[0]],
      localModelId: 'b',
      model: null,
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Use Model B' }))
    expect(screen.getByRole('button', { name: 'Reorder Model A' })).toBeInTheDocument()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare.mock.calls[1][0]).toMatchObject({
      models: [models[0]],
      localModelId: 'a',
      model: managedModel,
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Use Model A' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('preserves a local model, missing MCP selections and saved skill instructions when editing', async () => {
    const agent = agentFixture(true)
    agent.config = {
      ...agent.config,
      localModelId: 'local-model',
      model: null,
      mcpServers: [{ sourceId: 'missing-mcp', name: 'Desktop files' }],
      skills: [
        {
          sourceId: 'missing-skill',
          name: 'Saved skill',
          description: '',
          instruction: 'Use these saved instructions.',
        },
      ],
    }
    const transport = editorClient(agent)
    renderDetail(transport.client, agent)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /^Connections/ }))
    expect(screen.getByRole('switch', { name: 'Use Desktop files' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /^Skills/ }))
    expect(screen.getByRole('switch', { name: 'Use Saved skill' })).toBeChecked()
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(transport.prepare.mock.calls[0]?.[0]).toMatchObject({
      name: 'Renamed',
      localModelId: 'local-model',
      model: null,
      mcpServers: agent.config.mcpServers,
      skills: agent.config.skills,
    })
  })

  it('freezes the complete enabled/config command after response loss and retries that same command', async () => {
    const agent = agentFixture(false)
    const transport = editorClient(agent)
    transport.submit.mockRejectedValueOnce(new TypeError('Response lost'))
    renderDetail(transport.client, agent)
    await flush()

    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Instructions saved with activation' },
    })
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
    await flush()
    expect(screen.getByText('Response lost')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toBeDisabled()
    expect(transport.submit.mock.calls[0][0]).toMatchObject({ expectedVersion: 7, enabled: false })

    fireEvent.submit(screen.getByRole('button', { name: 'Retry save' }).closest('form')!)
    await flush()
    expect(transport.prepare).toHaveBeenCalledTimes(1)
    expect(transport.submit).toHaveBeenCalledTimes(2)
    expect(transport.submit.mock.calls[1][0]).toBe(transport.submit.mock.calls[0][0])
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Instructions saved with activation')
    expect(transport.autosave).not.toHaveBeenCalled()
  })
})
