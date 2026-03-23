import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'

describe('createHaystackRoutes', () => {
  beforeEach(() => {
    clearSettingsCache()
  })

  afterEach(() => {
    // Reset env vars
    delete process.env.HAYSTACK_API_KEY
    delete process.env.HAYSTACK_BASE_URL
    delete process.env.HAYSTACK_WORKSPACE_NAME
    delete process.env.HAYSTACK_PIPELINE_NAME
    delete process.env.HAYSTACK_PIPELINE_ID
    delete process.env.HAYSTACK_PIPELINES
    clearSettingsCache()
  })

  it('should return empty pipelines when Haystack is not configured', async () => {
    // Explicitly clear haystack env vars (they may be in .env)
    process.env.HAYSTACK_API_KEY = ''
    process.env.HAYSTACK_WORKSPACE_NAME = ''
    process.env.HAYSTACK_PIPELINE_NAME = ''
    process.env.HAYSTACK_PIPELINE_ID = ''
    process.env.HAYSTACK_PIPELINES = ''
    clearSettingsCache()

    const { createHaystackRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createHaystackRoutes())

    const response = await app.handle(new Request('http://localhost/haystack/pipelines'))
    const data = await response.json()

    expect(data).toEqual({ data: [] })
  })

  it('should return configured pipelines from individual env vars', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_BASE_URL = 'https://api.test.com'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'my-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    clearSettingsCache()

    const { createHaystackRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createHaystackRoutes())

    const response = await app.handle(new Request('http://localhost/haystack/pipelines'))
    const data = (await response.json()) as { data: Array<{ slug: string; name: string; icon: string }> }

    expect(data.data).toHaveLength(1)
    expect(data.data[0].slug).toBe('my-pipeline')
    expect(data.data[0].name).toBe('Document Search')
    expect(data.data[0].icon).toBe('file-search')
  })

  it('should return configured pipelines from JSON env var', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINES = JSON.stringify([
      { slug: 'eng-docs', name: 'Engineering Docs', pipelineName: 'eng-v1', pipelineId: 'p1', icon: 'file-text' },
      { slug: 'legal', name: 'Legal Search', pipelineName: 'legal-v1', pipelineId: 'p2', icon: 'scale' },
    ])
    clearSettingsCache()

    const { createHaystackRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createHaystackRoutes())

    const response = await app.handle(new Request('http://localhost/haystack/pipelines'))
    const data = (await response.json()) as { data: Array<{ slug: string; name: string }> }

    expect(data.data).toHaveLength(2)
    expect(data.data[0].slug).toBe('eng-docs')
    expect(data.data[1].slug).toBe('legal')
  })

  it('should proxy file downloads', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'my-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    clearSettingsCache()

    const mockFetch = mock(() =>
      Promise.resolve(
        new Response('pdf-content', {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="test.pdf"',
          },
        }),
      ),
    )

    const { createHaystackRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createHaystackRoutes(mockFetch as unknown as typeof fetch))

    const response = await app.handle(new Request('http://localhost/haystack/files/file-abc-123'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    const body = await response.text()
    expect(body).toBe('pdf-content')
  })

  it('should reject invalid file IDs', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'my-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    clearSettingsCache()

    const { createHaystackRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createHaystackRoutes())

    const response = await app.handle(new Request('http://localhost/haystack/files/../etc/passwd'))
    // Invalid file ID should result in an error
    expect(response.status).not.toBe(200)
  })
})
