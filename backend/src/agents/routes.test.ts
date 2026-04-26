import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'

// Mock the registry fetch to avoid real HTTP calls in tests
const originalFetch = globalThis.fetch
const mockRegistryResponse = { version: '1.0.0', agents: [], extensions: [] }

describe('createAgentsRoutes', () => {
  beforeEach(() => {
    clearSettingsCache()
    // Mock fetch to return empty registry
    globalThis.fetch = mock(async (url: any) => {
      if (typeof url === 'string' && url.includes('agentclientprotocol.com')) {
        return new Response(JSON.stringify(mockRegistryResponse), { status: 200 })
      }
      return originalFetch(url)
    }) as any
  })

  afterEach(() => {
    delete process.env.HAYSTACK_API_KEY
    delete process.env.HAYSTACK_BASE_URL
    delete process.env.HAYSTACK_WORKSPACE_NAME
    delete process.env.HAYSTACK_PIPELINE_NAME
    delete process.env.HAYSTACK_PIPELINE_ID
    delete process.env.HAYSTACK_PIPELINES
    delete process.env.ENABLED_AGENTS
    delete process.env.ALLOW_CUSTOM_AGENTS
    clearSettingsCache()
    globalThis.fetch = originalFetch
  })

  type RegistryResponse = {
    version: string
    agents: Array<Record<string, unknown>>
    extensions: unknown[]
    allowCustomAgents: boolean
  }

  const getRemoteAgents = (data: RegistryResponse) => data.agents.filter((a: any) => a.distribution?.remote)

  const getRemoteUrl = (agent: Record<string, unknown>) => (agent.distribution as any)?.remote?.url

  it('should return empty agents when no agents configured', async () => {
    process.env.HAYSTACK_API_KEY = ''
    process.env.HAYSTACK_WORKSPACE_NAME = ''
    process.env.HAYSTACK_PIPELINE_NAME = ''
    process.env.HAYSTACK_PIPELINE_ID = ''
    process.env.HAYSTACK_PIPELINES = ''
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse

    expect(data.version).toBe('1.0.0')
    expect(data.agents).toHaveLength(0)
    expect(data.extensions).toEqual([])
  })

  it('should return Haystack agents in registry format when configured via individual env vars', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'my-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse
    const remoteAgents = getRemoteAgents(data)

    expect(remoteAgents).toHaveLength(1)
    expect(remoteAgents[0].id).toBe('agent-haystack-my-pipeline')
    expect(remoteAgents[0].name).toBe('Document Search')
    expect(getRemoteUrl(remoteAgents[0])).toBe('ws://localhost/v1/haystack/ws/my-pipeline')
  })

  it('should return multiple Haystack agents from JSON env var', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINES = JSON.stringify([
      { slug: 'eng-docs', name: 'Engineering Docs', pipelineName: 'eng-v1', pipelineId: 'p1', icon: 'file-text' },
      { slug: 'legal', name: 'Legal Search', pipelineName: 'legal-v1', pipelineId: 'p2', icon: 'scale' },
    ])
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse
    const remoteAgents = getRemoteAgents(data)

    expect(remoteAgents).toHaveLength(2)
    expect(remoteAgents[0].id).toBe('agent-haystack-eng-docs')
    expect((remoteAgents[0].distribution as any).remote.icon).toBe('file-text')
    expect(remoteAgents[1].id).toBe('agent-haystack-legal')
    expect((remoteAgents[1].distribution as any).remote.icon).toBe('scale')
  })

  it('should filter agents by ENABLED_AGENTS when set', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINES = JSON.stringify([
      { slug: 'eng-docs', name: 'Engineering Docs', pipelineName: 'eng-v1', pipelineId: 'p1' },
      { slug: 'legal', name: 'Legal Search', pipelineName: 'legal-v1', pipelineId: 'p2' },
      { slug: 'hr', name: 'HR Docs', pipelineName: 'hr-v1', pipelineId: 'p3' },
    ])
    process.env.ENABLED_AGENTS = 'agent-haystack-eng-docs,agent-haystack-hr'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse

    expect(data.agents).toHaveLength(2)
    expect(data.agents[0].id).toBe('agent-haystack-eng-docs')
    expect(data.agents[1].id).toBe('agent-haystack-hr')
  })

  it('should return all agents when ENABLED_AGENTS is not set', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINES = JSON.stringify([
      { slug: 'eng-docs', name: 'Engineering Docs', pipelineName: 'eng-v1', pipelineId: 'p1' },
      { slug: 'legal', name: 'Legal Search', pipelineName: 'legal-v1', pipelineId: 'p2' },
    ])
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse

    expect(data.agents).toHaveLength(2)
  })

  it('should return empty when ENABLED_AGENTS matches no configured agents', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'docs'
    process.env.HAYSTACK_PIPELINE_ID = 'p1'
    process.env.ENABLED_AGENTS = 'agent-haystack-nonexistent'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse

    expect(data.agents).toHaveLength(0)
  })

  it('should derive WebSocket URLs from request origin', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'docs'
    process.env.HAYSTACK_PIPELINE_ID = 'p1'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('https://api.example.com/agents'))
    const data = (await response.json()) as RegistryResponse
    const remoteAgents = getRemoteAgents(data)

    expect(getRemoteUrl(remoteAgents[0])).toBe('wss://api.example.com/v1/haystack/ws/docs')
  })

  it('should use wss when X-Forwarded-Proto is https (reverse proxy)', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'docs'
    process.env.HAYSTACK_PIPELINE_ID = 'p1'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(
      new Request('http://localhost/agents', {
        headers: { 'x-forwarded-proto': 'https' },
      }),
    )
    const data = (await response.json()) as RegistryResponse
    const remoteAgents = getRemoteAgents(data)

    expect(getRemoteUrl(remoteAgents[0])).toBe('wss://localhost/v1/haystack/ws/docs')
  })

  it('should include allowCustomAgents: true in response by default', async () => {
    delete process.env.ALLOW_CUSTOM_AGENTS
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse

    expect(data.allowCustomAgents).toBe(true)
  })

  it('should include allowCustomAgents: false when ALLOW_CUSTOM_AGENTS=false', async () => {
    process.env.ALLOW_CUSTOM_AGENTS = 'false'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as RegistryResponse

    expect(data.allowCustomAgents).toBe(false)
  })
})
