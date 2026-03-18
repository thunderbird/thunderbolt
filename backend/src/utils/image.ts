/** Infers image content type from response header or URL extension */
export const inferImageContentType = (headerContentType: string | null, imageUrl: string): string => {
  if (headerContentType && headerContentType.startsWith('image/')) {
    return headerContentType
  }
  try {
    const ext = new URL(imageUrl).pathname.split('.').pop()?.toLowerCase()
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'svg') return 'image/svg+xml'
    return 'image/jpeg'
  } catch {
    return 'image/jpeg'
  }
}

/**
 * Fetches and proxies an image with size limits and timeout.
 * Returns a Response with the image data or an error response.
 */
export const fetchAndProxyImage = async (
  imageUrl: string,
  fetchFn: typeof fetch,
  ctx: { set: { status?: number | string } },
): Promise<Response> => {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 2000)

    try {
      const response = await fetchFn(imageUrl, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        ctx.set.status = response.status
        const errorMessage = response.statusText || `HTTP ${response.status}`
        return new Response(`Failed to fetch image: ${errorMessage}`, {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const contentLength = response.headers.get('content-length')
      const maxSizeBytes = 2 * 1024 * 1024 // 2MB limit
      const parsedLength = contentLength ? parseInt(contentLength, 10) : null
      if (parsedLength !== null && !Number.isNaN(parsedLength) && parsedLength > 0 && parsedLength > maxSizeBytes) {
        ctx.set.status = 413
        return new Response('Image too large', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const buffer = await response.arrayBuffer()

      if (buffer.byteLength > maxSizeBytes) {
        ctx.set.status = 413
        return new Response('Image too large', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const contentType = inferImageContentType(response.headers.get('content-type'), imageUrl)

      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      })
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      ctx.set.status = 408
      return new Response('Image fetch timeout', {
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    console.error('Link preview image error:', error)
    ctx.set.status = 500
    return new Response('Image fetch failed', {
      headers: { 'Content-Type': 'text/plain' },
    })
  }
}
