import type { Auth } from '@/auth/elysia-plugin'
import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'

/** Mock auth that always returns an authenticated user */
const createMockAuth = (): Auth =>
  ({
    api: {
      getSession: () => Promise.resolve({ user: { id: 'test-user' }, session: {} }),
    },
  }) as unknown as Auth

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

    const app = new Elysia().use(createHaystackRoutes(createMockAuth(), mockFetch as unknown as typeof fetch))

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

    const app = new Elysia().use(createHaystackRoutes(createMockAuth()))

    const response = await app.handle(new Request('http://localhost/haystack/files/../etc/passwd'))
    // Invalid file ID should result in an error
    expect(response.status).not.toBe(200)
  })

  it('should return 401 for unauthenticated requests', async () => {
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'my-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    clearSettingsCache()

    const unauthAuth = {
      api: { getSession: () => Promise.resolve(null) },
    } as unknown as Auth

    const { createHaystackRoutes } = await import('./routes')
    const { Elysia } = await import('elysia')

    const app = new Elysia().use(createHaystackRoutes(unauthAuth))

    const response = await app.handle(new Request('http://localhost/haystack/files/file-abc-123'))
    expect(response.status).toBe(401)
  })
})
