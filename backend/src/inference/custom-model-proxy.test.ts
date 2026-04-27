/**
 * Unit tests for custom-model-proxy routes.
 *
 * Run with: bun test custom-model-proxy.test.ts
 */
import { describe, expect, it } from 'bun:test'
import { validateProxyRequest, validateModelsRequest } from './custom-model-proxy'

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe('validateProxyRequest — invalid scheme', () => {
  it('rejects ftp://', () => {
    const result = validateProxyRequest('ftp://example.com/v1/chat/completions')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })

  it('rejects http://', () => {
    const result = validateProxyRequest('http://example.com/v1/chat/completions')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })
})

describe('validateProxyRequest — SSRF smoke test', () => {
  it('rejects 127.0.0.1 loopback', () => {
    const result = validateProxyRequest('http://127.0.0.1/v1/chat/completions')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(['SSRF_BLOCKED', 'INVALID_URL']).toContain(result.code)
  })
})

describe('validateProxyRequest — header injection defense', () => {
  it('rejects upstreamAuth with CRLF', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions', 'Bearer sk\r\nX-Injected: evil')
    expect(result.valid).toBe(false)
  })

  it('accepts valid printable ASCII upstreamAuth', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions', 'Bearer sk-test1234')
    expect(result.valid).toBe(true)
  })
})

describe('validateModelsRequest', () => {
  it('builds correct models URL from base', () => {
    const result = validateModelsRequest('https://api.openai.com/v1')
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.modelsUrl).toBe('https://api.openai.com/v1/models')
  })

  it('strips trailing slash before appending /models', () => {
    const result = validateModelsRequest('https://api.openai.com/v1/')
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.modelsUrl).toBe('https://api.openai.com/v1/models')
  })
})

// ---------------------------------------------------------------------------
// No API key in response types
// ---------------------------------------------------------------------------

describe('validateProxyRequest — upstreamAuth not echoed back', () => {
  it('success result does not contain upstreamAuth', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions', 'sk-secret-key')
    expect(result.valid).toBe(true)
    // The success result must not leak the upstream auth back to the caller.
    expect(JSON.stringify(result)).not.toContain('sk-secret-key')
    expect(JSON.stringify(result)).not.toContain('upstreamAuth')
  })
})
