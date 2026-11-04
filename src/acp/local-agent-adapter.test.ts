/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { describe, expect, it, mock } from 'bun:test'
import { cloudAgentViewFixture } from '@/cloud-agent/agent-inventory-fixture'
import { cloudAgentToAgent } from '@/cloud-agent/agent-inventory'
import type { CloudAgentView, CloudConnectionView } from '@/cloud-agent/client'
import type { NamedMCPClient } from '@/lib/mcp-provider'
import { createMockChatThread, createMockModel } from '@/test-utils/chat-store-mocks'
import { createMockHttpClient } from '@/test-utils/http-client'
import type { AgentAdapterContext } from '@/types/acp'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { AiFetchStreamingResponseFn } from './built-in-adapter'
import { connectToAgent } from './connect'
import {
  createLocalAgentAdapter,
  createLocalAgentToolApproval,
  localAgentMcpSelection,
  selectLocalAgentMcpClients,
} from './local-agent-adapter'

const httpClient = createMockHttpClient()
const selectedMcp = { id: 'selected', name: 'Selected MCP', url: 'https://local.test', client: {} } as NamedMCPClient
const unrelatedMcp = { ...selectedMcp, id: 'other', name: 'Other MCP' }
const model = createMockModel({ id: 'configured-model', toolUsage: 0 })

const viewFixture = (): CloudAgentView => {
  const view = cloudAgentViewFixture()
  return {
    ...view,
    config: {
      ...view.config,
      localModelId: model.id,
      mcpServers: [
        { sourceId: selectedMcp.id, name: selectedMcp.name },
        { sourceId: 'missing', name: 'Laptop files' },
      ],
    },
  }
}

const contextFixture = (): AgentAdapterContext => ({
  threadId: 'local-chat',
  chatThread: null,
  acpSessionId: null,
  saveMessages: async () => {},
  selectedModel: createMockModel({ id: 'unrelated-model', toolUsage: 0 }),
  mcpClients: [selectedMcp, unrelatedMcp],
  reconnectClient: async () => null,
  httpClient,
  getProxyFetch: () => Object.assign(async () => new Response(), { preconnect: async () => false }),
  onAcpSessionId: async () => {},
})

const setup = (view = viewFixture()) => {
  const agent = { ...cloudAgentToAgent(view), executionEnvironment: 'local' as const }
  const calls: Parameters<AiFetchStreamingResponseFn>[0][] = []
  const agents = mock(async () => [view])
  const connections = mock(async (): Promise<CloudConnectionView[]> => [])
  const loadModel = mock(async () => model)
  const deps = {
    createLocalAgentClient: () => ({ agents, connections }),
    loadLocalAgentModel: loadModel,
    aiFetch: async (input: Parameters<AiFetchStreamingResponseFn>[0]) => {
      calls.push(input)
      return new Response('ok')
    },
  }
  return {
    agent,
    calls,
    agents,
    connections,
    loadModel,
    deps,
    adapter: createLocalAgentAdapter(agent, httpClient, deps),
  }
}

describe('local saved agent execution', () => {
  it('routes through the local adapter and supplies only its saved choices to the legacy engine', async () => {
    const run = setup()
    const context = contextFixture()
    const adapter = await connectToAgent(run.agent, context, run.deps)
    await adapter.fetch({ body: '{}' }, context)
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toMatchObject({
      modelId: model.id,
      mcpClients: [selectedMcp],
      agentConfiguration: {
        instructions: 'SECRET INSTRUCTIONS',
        skills: viewFixture().config.skills,
        searchEnabled: false,
        unavailableCapabilities: ['Laptop files'],
      },
    })
    expect(run.connections).not.toHaveBeenCalled()
    expect(context.selectedModel.id).toBe('unrelated-model')
    expect(context.mcpClients).toHaveLength(2)
  })

  it('reloads the saved definition each turn so removed permissions do not remain cached', async () => {
    const run = setup()
    await run.adapter.fetch({}, contextFixture())
    const edited = viewFixture()
    edited.config = { ...edited.config, instructions: 'Updated instructions', skills: [], mcpServers: [] }
    run.agents.mockResolvedValue([edited])
    await run.adapter.fetch({}, contextFixture())
    expect(run.calls[1]).toMatchObject({
      mcpClients: [],
      agentConfiguration: { instructions: 'Updated instructions', skills: [] },
    })
  })

  it('can execute a local-only definition without a cloud model or cloud connection', async () => {
    const view = viewFixture()
    view.config.model = null
    const run = setup(view)
    await run.adapter.fetch({}, contextFixture())
    expect(run.calls[0]?.modelId).toBe(model.id)
  })

  it('does not substitute another local model when the configured model is missing', async () => {
    const run = setup()
    const adapter = createLocalAgentAdapter(run.agent, httpClient, {
      ...run.deps,
      loadLocalAgentModel: async () => null,
    })
    await expect(adapter.fetch({}, contextFixture())).rejects.toThrow('model is unavailable')
    expect(run.calls).toHaveLength(0)
  })

  it('rejects an edited model that would change an existing chat privacy boundary', async () => {
    const run = setup()
    const context = { ...contextFixture(), chatThread: createMockChatThread({ isEncrypted: 1 }) }
    await expect(run.adapter.fetch({}, context)).rejects.toThrow('privacy setting')
    expect(run.calls).toHaveLength(0)
  })

  it.each(['disabled', 'deleted', 'wrong owner'] as const)('rejects a %s saved definition', async (condition) => {
    const run = setup()
    const view = viewFixture()
    if (condition === 'disabled') {
      view.record.enabled = false
    }
    if (condition === 'deleted') {
      view.record.deletedAt = '2026-10-23T00:00:00Z'
    }
    if (condition === 'wrong owner') {
      view.record.ownerId = 'someone-else'
    }
    run.agents.mockResolvedValue([view])
    await expect(run.adapter.fetch({}, contextFixture())).rejects.toThrow('no longer available')
    expect(run.calls).toHaveLength(0)
  })

  it('continues without legacy MCPs when their mapping is unavailable', async () => {
    const view = viewFixture()
    delete view.config.mcpServers
    const run = setup(view)
    run.connections.mockRejectedValue(new Error('Offline'))
    await run.adapter.fetch({}, contextFixture())
    expect(run.calls[0]?.mcpClients).toEqual([])
    expect(run.calls[0]?.agentConfiguration?.unavailableCapabilities).toEqual([
      'Some saved connections have no connection on this device',
    ])
  })
})

describe('local connection selection', () => {
  it('does not infer permission from an identically named connection', () => {
    const other = { ...unrelatedMcp, name: selectedMcp.name }
    expect(selectLocalAgentMcpClients([{ sourceId: 'selected', name: 'Chosen' }], [other])).toEqual({
      clients: [],
      unavailable: ['Chosen'],
    })
  })

  it('uses only a legacy binding library reference and never its remote credentials or endpoint', () => {
    const view = viewFixture()
    delete view.config.mcpServers
    const binding: CloudConnectionView = {
      record: { ...view.record, id: 'secret-connection', status: 'ready' },
      config: {
        name: 'Selected MCP',
        kind: 'mcp',
        url: 'https://cloud-only.test',
        libraryRef: { kind: 'mcp', id: selectedMcp.id },
        authentication: { type: 'bearer', token: 'cloud-secret' },
      },
    }
    const selection = localAgentMcpSelection(view.config, [binding])
    expect(selection).toEqual([{ sourceId: selectedMcp.id, name: 'Selected MCP' }])
    expect(selectLocalAgentMcpClients(selection, [selectedMcp, unrelatedMcp]).clients).toEqual([selectedMcp])
    expect(JSON.stringify(selection)).not.toContain('cloud-secret')
    expect(JSON.stringify(selection)).not.toContain('cloud-only.test')
  })
})

describe('local saved agent approvals', () => {
  const call = { toolName: 'write', toolCallId: 'call', input: { path: 'notes.md' } }

  it('fails closed without an approval handler and skips approval only for explicit full access', async () => {
    expect(await createLocalAgentToolApproval(contextFixture())(call)).toBe(false)
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'cancelled' } }),
    )
    const approve = createLocalAgentToolApproval({
      ...contextFixture(),
      requestPermission,
      agentApprovalMode: 'full-access',
    })
    expect(await approve(call)).toBe(true)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('serializes concurrent prompts and distinguishes approval from denial', async () => {
    const first = Promise.withResolvers<RequestPermissionResponse>()
    const requestPermission = mock(async (): Promise<RequestPermissionResponse> => first.promise)
    requestPermission.mockImplementationOnce(() => first.promise)
    requestPermission.mockImplementationOnce(async () => ({ outcome: { outcome: 'selected', optionId: 'denied' } }))
    const approve = createLocalAgentToolApproval({ ...contextFixture(), requestPermission })
    const one = approve(call)
    const two = approve({ ...call, toolCallId: 'second' })
    await Promise.resolve()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    first.resolve({ outcome: { outcome: 'selected', optionId: 'approved' } })
    expect(await one).toBe(true)
    expect(await two).toBe(false)
    expect(requestPermission).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending prompt and never accepts a late approval', async () => {
    const decision = Promise.withResolvers<RequestPermissionResponse>()
    const requestPermission = mock(async () => decision.promise)
    const approve = createLocalAgentToolApproval({ ...contextFixture(), requestPermission })
    const abort = new AbortController()
    const pending = approve(call, abort.signal)
    await Promise.resolve()
    abort.abort()
    expect(await pending).toBe(false)
    decision.resolve({ outcome: { outcome: 'selected', optionId: 'approved' } })
    expect(await approve(call, abort.signal)).toBe(false)
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })
})
