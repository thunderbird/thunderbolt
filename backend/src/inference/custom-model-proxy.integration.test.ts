/**
 * TLS-SNI monitoring integration test.
 *
 * Tagged: network — runs in nightly CI only; non-blocking for PR merge.
 * Set INTEGRATION=1 to run locally.
 *
 * Purpose: verify that createSafeFetch completes a TLS handshake against
 * api.openai.com and returns HTTP 401 (not a TLS error). A TLS-level failure
 * would indicate Bun #27890 (hostname-is-IP SNI regression) and block
 * production cutover.
 *
 * See RESEARCH-001 v4 §A10 step 4 + contract §v4 new ACs.
 */
import { describe, expect, it } from 'bun:test'
import { createSafeFetch } from '@/utils/url-validation'

const INTEGRATION = process.env.INTEGRATION === '1'

describe.skipIf(!INTEGRATION)('TLS-SNI monitoring (network)', () => {
  it('fetch api.openai.com/v1/models via createSafeFetch returns 401 (proves TLS handshake)', async () => {
    const safeFetch = createSafeFetch(globalThis.fetch)

    const response = await safeFetch('https://api.openai.com/v1/models', {
      headers: {
        Authorization: 'Bearer sk-invalid-test-key-for-monitoring',
        'User-Agent': 'Thunderbolt-Proxy/1.0',
      },
    })

    // HTTP 401 proves TLS handshake and SNI completed correctly.
    // Any TLS-level error would throw rather than returning a Response.
    expect(response.status).toBe(401)

    const body = await response.json()
    // OpenAI returns { error: { ... } } on 401
    expect(typeof body).toBe('object')
    expect(body).not.toBeNull()
  }, 30_000)
})
