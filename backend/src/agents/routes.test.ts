import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'

describe('createAgentsRoutes', () => {
  beforeEach(() => {
    clearSettingsCache()
  })

  afterEach(() => {
    delete process.env.HAYSTACK_API_KEY
    delete process.env.HAYSTACK_BASE_URL
    delete process.env.HAYSTACK_WORKSPACE_NAME
    delete process.env.HAYSTACK_PIPELINE_NAME
    delete process.env.HAYSTACK_PIPELINE_ID
    delete process.env.HAYSTACK_PIPELINES
    delete process.env.ENABLED_AGENTS
    clearSettingsCache()
  })

  it('should return empty data when no agents configured', async () => {
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
    const data = await response.json()

    expect(data).toEqual({ data: [] })
  })

  it('should return Haystack agents when configured via individual env vars', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'my-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    clearSettingsCache()

    const { createAgentsRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createAgentsRoutes())

    const response = await app.handle(new Request('http://localhost/agents'))
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data).toHaveLength(1)
    expect(data.data[0].id).toBe('agent-haystack-my-pipeline')
    expect(data.data[0].name).toBe('Document Search')
    expect(data.data[0].type).toBe('remote')
    expect(data.data[0].transport).toBe('websocket')
    expect(data.data[0].url).toBe('ws://localhost/v1/haystack/ws/my-pipeline')
    expect(data.data[0].icon).toBe('file-search')
    expect(data.data[0].isSystem).toBe(1)
    expect(data.data[0].enabled).toBe(1)
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
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data).toHaveLength(2)
    expect(data.data[0].id).toBe('agent-haystack-eng-docs')
    expect(data.data[0].icon).toBe('file-text')
    expect(data.data[1].id).toBe('agent-haystack-legal')
    expect(data.data[1].icon).toBe('scale')
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
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data).toHaveLength(2)
    expect(data.data[0].id).toBe('agent-haystack-eng-docs')
    expect(data.data[1].id).toBe('agent-haystack-hr')
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
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data).toHaveLength(2)
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
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data).toHaveLength(0)
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
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data[0].url).toBe('wss://api.example.com/v1/haystack/ws/docs')
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
    const data = (await response.json()) as { data: Array<Record<string, unknown>> }

    expect(data.data[0].url).toBe('wss://localhost/v1/haystack/ws/docs')
  })
})
