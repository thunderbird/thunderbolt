import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createCustomProxyFetch } from './custom-proxy-fetch'
import * as platformModule from '@/lib/platform'
import { createMockHttpClient, createSpyHttpClient, jsonResponse } from '@/test-utils/http-client'

const cloudUrl = 'https://animal.inference.thunderbolt.io/v1'
const localUrl = 'http://localhost:11434/v1'
const targetUrl = `${cloudUrl}/chat/completions`
const localTargetUrl = `${localUrl}/chat/completions`

const makeInit = (overrides: Partial<RequestInit> = {}): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-4', messages: [], stream: false }),
  headers: { 'Content-Type': 'application/json' },
  ...overrides,
})

const makeStreamInit = (): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-4', messages: [], stream: true }),
  headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
})

describe('createCustomProxyFetch', () => {
  let isTauriSpy: ReturnType<typeof spyOn>
  let globalFetchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    isTauriSpy = spyOn(platformModule, 'isTauri').mockReturnValue(false)
    globalFetchSpy = mock(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = globalFetchSpy as unknown as typeof globalThis.fetch
  })

  describe('Tauri path (US-003 regression guard)', () => {
    it('delegates to injected tauriFetch when isTauri() is true', async () => {
      isTauriSpy.mockReturnValue(true)
      const tauriFetchSpy = mock(async () => new Response('tauri-response', { status: 200 }))
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({
        baseURL: cloudUrl,
        httpClient,
        tauriFetch: tauriFetchSpy as unknown as typeof fetch,
      })

      await proxyFetch(targetUrl, makeInit())

      // Tauri fetch must be invoked, backend proxy must NOT be called.
      expect(tauriFetchSpy).toHaveBeenCalledWith(targetUrl, expect.anything())
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(isTauriSpy).toHaveBeenCalled()
    })
  })

  describe('Web + localhost baseURL — CORS carve-out', () => {
    it('calls globalThis.fetch with the original URL when baseURL is localhost', async () => {
      const httpClient = createMockHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: localUrl, httpClient })

      await proxyFetch(localTargetUrl, makeInit())

      expect(globalFetchSpy).toHaveBeenCalledWith(localTargetUrl, expect.anything())
    })

    it('does not call httpClient.post for localhost baseURL', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: localUrl, httpClient })

      await proxyFetch(localTargetUrl, makeInit())

      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('calls globalThis.fetch for 127.0.0.1 baseURL', async () => {
      const httpClient = createMockHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: 'http://127.0.0.1:8080/v1', httpClient })

      await proxyFetch('http://127.0.0.1:8080/v1/chat/completions', makeInit())

      expect(globalFetchSpy).toHaveBeenCalled()
    })
  })

  describe('Web + cloud baseURL — proxy routing', () => {
    it('calls httpClient.post with correct proxy request shape', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient(async () => {
        return jsonResponse({ data: {} })
      })
      const proxyFetch = createCustomProxyFetch({
        baseURL: cloudUrl,
        upstreamAuth: 'sk-test-key',
        httpClient,
      })

      await proxyFetch(targetUrl, makeInit())

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const calledReq = fetchSpy.mock.calls[0][0] as Request
      const body = JSON.parse(await calledReq.clone().text())
      expect(body.targetUrl).toBe(targetUrl)
      expect(body.upstreamAuth).toBe('sk-test-key')
      expect(body.method).toBe('POST')
      expect(body.stream).toBe(false)
    })

    it('sets stream: true when body.stream is true', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })

      await proxyFetch(targetUrl, makeStreamInit())

      const calledReq = fetchSpy.mock.calls[0][0] as Request
      const body = JSON.parse(await calledReq.clone().text())
      expect(body.stream).toBe(true)
    })

    it('sets stream: true when Accept header is text/event-stream', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })

      await proxyFetch(targetUrl, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4', messages: [], stream: false }),
        headers: { accept: 'text/event-stream' },
      })

      const calledReq = fetchSpy.mock.calls[0][0] as Request
      const body = JSON.parse(await calledReq.clone().text())
      expect(body.stream).toBe(true)
    })

    it('sets upstreamAuth to undefined when no apiKey supplied', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })

      await proxyFetch(targetUrl, makeInit())

      const calledReq = fetchSpy.mock.calls[0][0] as Request
      const body = JSON.parse(await calledReq.clone().text())
      expect(body.upstreamAuth).toBeUndefined()
    })

    it('does NOT call globalThis.fetch for cloud URL', async () => {
      const { httpClient } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })

      await proxyFetch(targetUrl, makeInit())

      expect(globalFetchSpy).not.toHaveBeenCalled()
    })

    it('forwards AbortSignal to the backend client', async () => {
      const controller = new AbortController()
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })

      await proxyFetch(targetUrl, { ...makeInit(), signal: controller.signal })

      const calledReq = fetchSpy.mock.calls[0][0] as Request
      expect(calledReq.signal).toBe(controller.signal)
    })

    it('routes to the custom-model/proxy endpoint', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })

      await proxyFetch(targetUrl, makeInit())

      const calledReq = fetchSpy.mock.calls[0][0] as Request
      expect(calledReq.url).toContain('custom-model/proxy')
    })
  })

  describe('Security invariants', () => {
    it('upstreamAuth is in the request body, not an Authorization header to the backend', async () => {
      const { httpClient, fetchSpy } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({
        baseURL: cloudUrl,
        upstreamAuth: 'sk-secret',
        httpClient,
      })

      await proxyFetch(targetUrl, makeInit())

      const calledReq = fetchSpy.mock.calls[0][0] as Request
      // Authorization header in the browser→backend leg must NOT contain the upstream key.
      const authHeader = calledReq.headers.get('Authorization')
      // authHeader is either null (no auth header set) or a bearer token for the Thunderbolt backend,
      // not the upstream key — either way, the upstream key must not appear in it.
      expect(authHeader ?? '').not.toContain('sk-secret')
    })

    it('no globalThis.fetch call for cloud URL (bare-fetch guard)', async () => {
      const { httpClient } = createSpyHttpClient()
      const proxyFetch = createCustomProxyFetch({ baseURL: cloudUrl, httpClient })
      await proxyFetch(targetUrl, makeInit())
      expect(globalFetchSpy).not.toHaveBeenCalled()
    })
  })
})
