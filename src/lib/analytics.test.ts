import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { initPosthog, sanitizeUrl } from './analytics'

const mockKyGet = mock()
const mockKyPost = mock()
const mockKyJson = mock()
const mockPosthogInit = mock()
let capturedOptions: any = null

mock.module('ky', () => ({
  default: {
    get: mockKyGet,
    post: mockKyPost,
  },
}))

mock.module('posthog-js', () => ({
  default: {
    init: (...args: any[]) => {
      const [, options] = args
      capturedOptions = options
      return mockPosthogInit(...args)
    },
  },
}))

mock.module('@/lib/config', () => ({
  getCloudUrl: async () => 'http://cloud.example',
}))

mock.module('@/lib/dal', () => ({
  getSettings: async (defaults: Record<string, any>) => {
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(defaults)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
      result[camelKey] = value
    }
    return result
  },
}))

describe('analytics sanitizeUrl', () => {
  it('replaces dynamic chat IDs with route params for pathnames', () => {
    expect(sanitizeUrl('/chats/123')).toBe('/chats/:chatThreadId')
    expect(sanitizeUrl('/chats/abc-123')).toBe('/chats/:chatThreadId')
  })

  it('replaces dynamic chat IDs for full URLs and preserves query', () => {
    const input = 'https://app.test/chats/abc-123?x=1#hash'
    const expected = 'https://app.test/chats/:chatThreadId?x=1#hash'
    expect(sanitizeUrl(input)).toBe(expected)
  })

  it('returns input when no route pattern matches', () => {
    expect(sanitizeUrl('/settings')).toBe('/settings')
    expect(sanitizeUrl('https://app.test/settings?tab=account')).toBe('https://app.test/settings?tab=account')
  })
})

describe('analytics before_send sanitization', () => {
  beforeEach(() => {
    capturedOptions = null
    mockKyGet.mockReset()
    mockKyPost.mockReset()
    mockKyJson.mockReset()
    mockPosthogInit.mockReset()
    mockKyGet.mockReturnValue({ json: mockKyJson })
    // Ensure a stable ky.post shape for any accidental use during this file's run
    mockKyPost.mockReturnValue({ json: mockKyJson })
    mockKyJson.mockResolvedValue({ posthog_api_key: 'test-key' })
  })

  it('sanitizes $current_url, url, and $pathname when strings', async () => {
    await initPosthog()
    expect(capturedOptions).toBeTruthy()

    const event = {
      event: '$pageview',
      properties: {
        $current_url: 'https://app/chats/123?x=1',
        url: 'https://app/chats/456',
        $pathname: '/chats/789',
      },
    } as any

    const result = capturedOptions.before_send(event)
    expect(result.properties.$current_url).toBe('https://app/chats/:chatThreadId?x=1')
    expect(result.properties.url).toBe('https://app/chats/:chatThreadId')
    expect(result.properties.$pathname).toBe('/chats/:chatThreadId')
  })

  it('ignores non-string URL-like properties', async () => {
    await initPosthog()
    const event = {
      event: '$pageleave',
      properties: {
        $current_url: 123,
        url: { href: '/chats/1' },
        $pathname: null,
      },
    } as any

    const result = capturedOptions.before_send(event)
    expect(result.properties.$current_url).toBe(123)
    expect(result.properties.url).toEqual({ href: '/chats/1' })
    expect(result.properties.$pathname).toBeNull()
  })
})
