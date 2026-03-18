import { describe, expect, it, mock } from 'bun:test'
import { fetchAndProxyImage, inferImageContentType } from './image'

describe('inferImageContentType', () => {
  it('uses header content-type when it starts with image/', () => {
    expect(inferImageContentType('image/png', 'https://example.com/img.jpg')).toBe('image/png')
  })

  it('falls back to URL extension for png', () => {
    expect(inferImageContentType('text/html', 'https://example.com/img.png')).toBe('image/png')
  })

  it('falls back to URL extension for gif', () => {
    expect(inferImageContentType(null, 'https://example.com/img.gif')).toBe('image/gif')
  })

  it('falls back to URL extension for webp', () => {
    expect(inferImageContentType(null, 'https://example.com/img.webp')).toBe('image/webp')
  })

  it('falls back to URL extension for svg', () => {
    expect(inferImageContentType(null, 'https://example.com/img.svg')).toBe('image/svg+xml')
  })

  it('defaults to image/jpeg for unknown extensions', () => {
    expect(inferImageContentType(null, 'https://example.com/img.bmp')).toBe('image/jpeg')
  })

  it('defaults to image/jpeg for invalid URLs', () => {
    expect(inferImageContentType(null, 'not-a-url')).toBe('image/jpeg')
  })
})

describe('fetchAndProxyImage', () => {
  it('returns proxied image on success', async () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const mockFetchFn = mock(() =>
      Promise.resolve(
        new Response(imageData, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    )
    const ctx = { set: { status: undefined as number | string | undefined } }

    const response = await fetchAndProxyImage(
      'https://example.com/image.png',
      mockFetchFn as unknown as typeof fetch,
      ctx,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
  })

  it('returns 413 when content-length exceeds 2MB', async () => {
    const mockFetchFn = mock(() =>
      Promise.resolve(
        new Response('', {
          status: 200,
          headers: { 'content-length': '3145728' }, // 3MB
        }),
      ),
    )
    const ctx = { set: { status: undefined as number | string | undefined } }

    const response = await fetchAndProxyImage(
      'https://example.com/large.png',
      mockFetchFn as unknown as typeof fetch,
      ctx,
    )

    expect(ctx.set.status).toBe(413)
    expect(await response.text()).toBe('Image too large')
  })

  it('returns upstream status on fetch failure', async () => {
    const mockFetchFn = mock(() =>
      Promise.resolve(
        new Response('Not Found', {
          status: 404,
          statusText: 'Not Found',
        }),
      ),
    )
    const ctx = { set: { status: undefined as number | string | undefined } }

    const response = await fetchAndProxyImage(
      'https://example.com/missing.png',
      mockFetchFn as unknown as typeof fetch,
      ctx,
    )

    expect(ctx.set.status).toBe(404)
    expect(await response.text()).toContain('Failed to fetch image')
  })
})
