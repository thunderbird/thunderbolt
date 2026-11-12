/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { PrivatemodeAI, type VerifyResult } from 'privatemode-ai'
import { validatePrivatemodeApiKey } from '@/ai/privatemode-client'
import { getClock } from '@/testing-library'
import { classifyErrorKind } from '@/lib/error-utils'
import { createAttestationStore } from './store'

mock.module('privatemode-wasm?url', () => ({ default: '/assets/privatemode.wasm' }))

const { AttestedPrivatemodeClient, createPrivatemodeFetch, readPrivatemodeEvidence, privatemodeWasmHash } =
  await import('./privatemode')

const apiURL = 'https://api.privatemode.ai/v1/chat/completions'
const request = { method: 'POST', body: JSON.stringify({ model: 'test', messages: [], stream: true }) }

/** Fake only the SDK's public contract; inference never receives unverified transport state. */
const setup = () => {
  const store = createAttestationStore()
  const proof: VerifyResult = {
    manifest: {
      Policies: {
        'expected-policy-hash': { SANs: ['worker.example'], WorkloadSecretID: 'not-evidence' },
      },
      ReferenceValues: {
        snp: [
          { TrustedMeasurement: 'expected-reference-not-observed' } as NonNullable<
            NonNullable<VerifyResult['manifest']['ReferenceValues']>['snp']
          >[number],
        ],
      },
    },
  }
  const response = mock(async () => new Response('data: {"result":"ok"}\n\ndata: [DONE]\n\n'))
  const sdk = {
    verify: mock(async () => proof),
    refreshSecret: mock(async () => {}),
    exportSecret: mock(() => ({
      id: 'secret-id',
      data: 'secret-key-material',
      expiresAtUnix: Math.floor(Date.now() / 1_000) + 3_600,
    })),
    manifestBytes: new TextEncoder().encode(JSON.stringify(proof.manifest)),
    request: mock((_options: Parameters<Parameters<typeof createPrivatemodeFetch>[0]['request']>[0]) => ({
      asResponse: response,
    })),
    close: mock(() => {}),
  }
  const client = new AttestedPrivatemodeClient(sdk, store.open('test'), 1_000)
  return { client, sdk, response, proof, snapshot: () => store.getSnapshot('test') }
}

afterEach(() => mock.restore())

describe('Privatemode evidence', () => {
  it('pins the bundled verifier asset to the reviewed SDK version', async () => {
    const file = Bun.file(new URL('../../node_modules/privatemode-ai/dist/privatemode.wasm', import.meta.url))
    expect(new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex')).toBe(privatemodeWasmHash)
  })

  it('reports deployment policy, without exposing secrets or presenting reference values as measured facts', async () => {
    const { sdk, proof } = setup()
    const evidence = await readPrivatemodeEvidence(proof, sdk.manifestBytes, 123)
    expect(evidence).toMatchObject({
      provider: 'Privatemode',
      verifiedAt: 123,
      endpoint: 'api.privatemode.ai',
      checks: ['hardware', 'policy', 'channel'],
    })
    expect(evidence.details).toContainEqual({ label: 'policy', value: 'expected-policy-hash: worker.example' })
    expect(evidence.details.find(({ label }) => label === 'manifest')?.value).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(evidence)).not.toContain('secret-key-material')
    expect(JSON.stringify(evidence)).not.toContain('expected-reference-not-observed')
    expect(JSON.stringify(evidence)).not.toContain('not-evidence')
  })

  it('waits for attestation and key establishment before publishing evidence or sending inference', async () => {
    const { client, sdk, snapshot } = setup()
    const established = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    sdk.refreshSecret.mockImplementation(() => {
      started.resolve()
      return established.promise
    })
    const pending = client.fetch(apiURL, request)
    await started.promise
    expect(snapshot()).toEqual({ status: 'verifying' })
    expect(sdk.request).not.toHaveBeenCalled()
    established.resolve()
    expect(await (await pending).text()).toContain('[DONE]')
    expect(snapshot().status).toBe('verified')
    await client.close()
  })

  it('expires visible evidence and re-verifies before a later request', async () => {
    const { client, sdk, snapshot } = setup()
    await client.ensureVerified()
    const initial = snapshot()
    await client.ensureVerified()
    expect(sdk.verify).toHaveBeenCalledTimes(1)
    expect(snapshot()).toBe(initial)
    await getClock().tickAsync(5 * 60 * 1_000)
    expect(snapshot()).toEqual({ status: 'idle' })
    await client.ensureVerified()
    expect(sdk.verify).toHaveBeenCalledTimes(2)
    expect(sdk.refreshSecret).toHaveBeenCalledTimes(2)
    expect(snapshot().status).toBe('verified')
    await client.close()
  })

  it('uses an earlier secret expiration to retire evidence', async () => {
    const { client, sdk, snapshot } = setup()
    sdk.exportSecret.mockReturnValue({ id: 'id', data: 'key', expiresAtUnix: Math.floor(Date.now() / 1_000) + 2 })
    await client.ensureVerified()
    await getClock().tickAsync(2_000)
    expect(snapshot()).toEqual({ status: 'idle' })
    await client.close()
  })

  it('never sends a prompt after a verifier or key establishment failure', async () => {
    const { client, sdk, snapshot } = setup()
    sdk.refreshSecret.mockRejectedValue(new Error('key binding rejected'))
    await expect(client.fetch(apiURL, request)).rejects.toThrow('key binding rejected')
    expect(sdk.request).not.toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
    expect(sdk.close).toHaveBeenCalled()
    await expect(client.ensureVerified()).rejects.toThrow('key binding rejected')
  })

  it('classifies rejected verification as attestation while preserving the vendor cause', async () => {
    const { client, sdk } = setup()
    const cause = new Error('coordinator manifest does not match')
    sdk.verify.mockRejectedValue(cause)
    const failure: unknown = await client.ensureVerified().catch((error: unknown) => error)
    expect(classifyErrorKind(failure)).toBe('attestation')
    expect(failure).toHaveProperty('cause', cause)
  })

  it.each([
    {
      method: 'verify' as const,
      message:
        'initializing client: offering credential to secret manager: setting secrets: All attempts fail:\n' +
        '#1: updating mesh CA: doing attest request: Unauthorized (status code: 401)\n' +
        '#2: updating mesh CA: doing attest request: Unauthorized (status code: 401)\n' +
        '#3: updating mesh CA: doing attest request: Unauthorized (status code: 401)',
      status: 401,
    },
    {
      method: 'refreshSecret' as const,
      message:
        'updating secret: getting latest secret: setting secrets: All attempts fail:\n' +
        '#1: doing request: unexpected status code: 403',
      status: 403,
    },
  ])('preserves credential rejection from $method as HTTP $status', async ({ method, message, status }) => {
    const { client, sdk, snapshot } = setup()
    const cause = new Error(message)
    sdk[method].mockRejectedValue(cause)
    const failure: unknown = await client.ensureVerified().catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'PrivatemodeAuthenticationError', status, cause })
    expect(classifyErrorKind(failure)).not.toBe('attestation')
    expect(sdk.request).not.toHaveBeenCalled()
    expect(sdk.close).toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it.each([
    'fetching manifest: unexpected status code: 403',
    'initializing client: offering credential to secret manager: setting secrets: All attempts fail:\n' +
      '#1: updating mesh CA: verifying certificate: OCSP request: unexpected status code: 403',
  ])('keeps unrelated status text as a verification failure: %s', async (message) => {
    const { client, sdk } = setup()
    const cause = new Error(message)
    sdk.verify.mockRejectedValue(cause)
    const failure: unknown = await client.ensureVerified().catch((error: unknown) => error)
    expect(classifyErrorKind(failure)).toBe('attestation')
    expect(failure).not.toHaveProperty('status')
    expect(failure).toHaveProperty('cause', cause)
  })

  it('rejects expired secrets before exposing a verified state', async () => {
    const { client, sdk, snapshot } = setup()
    sdk.exportSecret.mockReturnValue({ id: 'id', data: 'key', expiresAtUnix: Math.floor(Date.now() / 1_000) })
    await expect(client.ensureVerified()).rejects.toThrow('already expired')
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it('revokes evidence if the SDK can no longer read its established secret', async () => {
    const { client, sdk, snapshot } = setup()
    await client.ensureVerified()
    sdk.exportSecret.mockImplementation(() => {
      throw new Error('encryption secret is unavailable')
    })
    await expect(client.ensureVerified()).rejects.toThrow('encryption secret is unavailable')
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
    expect(sdk.close).toHaveBeenCalled()
  })

  it('discards late verification and frees SDK resources after timeout', async () => {
    const { client, sdk, proof, snapshot } = setup()
    const verification = Promise.withResolvers<VerifyResult>()
    sdk.verify.mockImplementation(() => verification.promise)
    const pending = client.ensureVerified()
    const result = pending.catch((error: unknown) => error)
    expect(client.ensureVerified()).toBe(pending)
    await getClock().tickAsync(1_000)
    expect(await result).toHaveProperty('name', 'PrivatemodeAttestationTimeoutError')
    expect(classifyErrorKind(await result)).toBe('timeout')
    verification.resolve(proof)
    await getClock().tickAsync(0)
    expect(sdk.refreshSecret).not.toHaveBeenCalled()
    expect(sdk.close).toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'timeout' })
  })

  it('revokes evidence on a decrypted stream failure', async () => {
    const { client, response, snapshot, sdk } = setup()
    const stream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    response.mockImplementation(async () => new Response(new ReadableStream({ start: stream.resolve })))
    const result = await client.fetch(apiURL, request)
    const reading = result
      .body!.getReader()
      .read()
      .catch((error: unknown) => error)
    const failure = new Error('encrypted response authentication failed')
    ;(await stream.promise).error(failure)
    const failureFromStream = await reading
    expect(failureFromStream).toHaveProperty('cause', failure)
    expect(classifyErrorKind(failureFromStream)).toBe('attestation')
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
    expect(sdk.close).toHaveBeenCalled()
  })

  it('re-verifies a manifest and secret rotated by the SDK during inference', async () => {
    const { client, sdk, response, snapshot } = setup()
    const rotated: VerifyResult = {
      manifest: { Policies: { rotated: { SANs: ['new-worker'], WorkloadSecretID: '' } } },
    }
    response.mockImplementation(async () => {
      sdk.manifestBytes = new TextEncoder().encode(JSON.stringify(rotated.manifest))
      sdk.verify.mockResolvedValue(rotated)
      sdk.exportSecret.mockReturnValue({ id: 'rotated-secret', data: 'key', expiresAtUnix: Date.now() / 1_000 + 600 })
      return new Response('result')
    })
    expect(await (await client.fetch(apiURL, request)).text()).toBe('result')
    expect(sdk.verify).toHaveBeenCalledTimes(2)
    expect(snapshot()).toMatchObject({
      status: 'verified',
      evidence: { details: expect.arrayContaining([{ label: 'policy', value: 'rotated: new-worker' }]) },
    })
    await client.close()
  })

  it('discards the response if a rotated deployment cannot be verified', async () => {
    const { client, sdk, response, snapshot } = setup()
    const cancel = mock(() => {})
    response.mockImplementation(async () => {
      sdk.manifestBytes = new TextEncoder().encode('{}')
      sdk.verify.mockRejectedValue(new Error('rotated deployment rejected'))
      return new Response(new ReadableStream({ cancel }))
    })
    await expect(client.fetch(apiURL, request)).rejects.toThrow('rotated deployment rejected')
    expect(cancel).toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it('fails closed if the deployment changes while establishing the secret', async () => {
    const { client, sdk, snapshot } = setup()
    sdk.refreshSecret.mockImplementation(async () => {
      sdk.manifestBytes = new TextEncoder().encode('{}')
    })
    await expect(client.fetch(apiURL, request)).rejects.toThrow('deployment changed')
    expect(sdk.request).not.toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it('cancels one waiting request without cancelling another request sharing verification', async () => {
    const { client, sdk, proof, snapshot } = setup()
    const verification = Promise.withResolvers<VerifyResult>()
    sdk.verify.mockImplementation(() => verification.promise)
    const caller = new AbortController()
    const cancelled = client.fetch(apiURL, { ...request, signal: caller.signal }).catch((error: unknown) => error)
    const surviving = client.fetch(apiURL, request)
    caller.abort()
    expect(await cancelled).toHaveProperty('name', 'AbortError')
    verification.resolve(proof)
    expect(await (await surviving).text()).toContain('[DONE]')
    expect(sdk.verify).toHaveBeenCalledTimes(1)
    expect(snapshot().status).toBe('verified')
    await client.close()
  })

  it('cancels pending response consumption and clears evidence on logout', async () => {
    const { client, response, snapshot } = setup()
    const cancel = mock(() => {})
    response.mockImplementation(async () => new Response(new ReadableStream({ cancel })))
    const result = await client.fetch(apiURL, request)
    const reading = result.text().catch((error: unknown) => error)
    await client.close()
    expect(await reading).toHaveProperty('name', 'AbortError')
    expect(cancel).toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'idle' })
  })

  it('does not call completed WASM request callbacks when the client later closes', async () => {
    const { client, sdk } = setup()
    const releasedCallback = mock(() => {})
    sdk.request.mockImplementation((options) => {
      // The SDK releases its Go callback when /models finishes, but leaves the
      // listener attached. A later abort would invoke that released function.
      options.signal.addEventListener('abort', releasedCallback, { once: true })
      return { asResponse: mock(async () => Response.json({ object: 'list', data: [] })) }
    })
    const response = await client.fetch('https://api.privatemode.ai/v1/models')
    await response.json()
    await client.close()
    expect(releasedCallback).not.toHaveBeenCalled()
  })

  it('still aborts a WASM request that is waiting for response headers', async () => {
    const { client, sdk } = setup()
    const started = Promise.withResolvers<void>()
    const aborted = mock(() => {})
    sdk.request.mockImplementation((options) => ({
      asResponse: mock(() => {
        started.resolve()
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              aborted()
              reject(options.signal.reason)
            },
            { once: true },
          )
        })
      }),
    }))
    const response = client.fetch('https://api.privatemode.ai/v1/models').catch((error: unknown) => error)
    await started.promise
    await client.close()
    expect(await response).toHaveProperty('name', 'AbortError')
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})

describe('unsaved Privatemode credential validation', () => {
  it('waits for the complete authenticated model catalog and releases its isolated client', async () => {
    const { client, sdk, response } = setup()
    const create = spyOn(AttestedPrivatemodeClient, 'create').mockResolvedValue(client)
    const started = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    response.mockImplementation(async () => new Response(new ReadableStream({ start: started.resolve })))
    const signal = new AbortController().signal
    const validation = validatePrivatemodeApiKey('unsaved-key', signal)
    const body = await started.promise
    body.enqueue(new TextEncoder().encode('{"object":"list","data":'))
    expect(sdk.close).not.toHaveBeenCalled()
    body.enqueue(new TextEncoder().encode('[]}'))
    body.close()
    await validation
    expect(create).toHaveBeenCalledWith({ apiKey: 'unsaved-key', signal }, expect.any(Object), 30_000)
    expect(sdk.verify).toHaveBeenCalledTimes(1)
    expect(sdk.request).toHaveBeenCalledTimes(1)
    expect(sdk.request.mock.calls[0][0]).toMatchObject({ method: 'get', path: '/models' })
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403])('propagates authenticated catalog rejection with HTTP %s', async (status) => {
    const { client, sdk, response } = setup()
    spyOn(AttestedPrivatemodeClient, 'create').mockResolvedValue(client)
    response.mockRejectedValue(new PrivatemodeAI.APIError(status, { message: 'rejected' }, undefined, new Headers()))
    await expect(validatePrivatemodeApiKey('invalid-key', new AbortController().signal)).rejects.toMatchObject({
      response: { status },
    })
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it('propagates a failed proof and never requests the catalog', async () => {
    const { client, sdk } = setup()
    spyOn(AttestedPrivatemodeClient, 'create').mockResolvedValue(client)
    const cause = new Error('manifest verification failed')
    sdk.verify.mockRejectedValue(cause)
    const failure: unknown = await validatePrivatemodeApiKey('unsaved-key', new AbortController().signal).catch(
      (error: unknown) => error,
    )
    expect(classifyErrorKind(failure)).toBe('attestation')
    expect(failure).toHaveProperty('cause', cause)
    expect(sdk.request).not.toHaveBeenCalled()
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it.each(['AbortError', 'TimeoutError'])('cancels catalog consumption and closes on %s', async (name) => {
    const { client, sdk, response } = setup()
    spyOn(AttestedPrivatemodeClient, 'create').mockResolvedValue(client)
    const started = Promise.withResolvers<void>()
    const cancel = mock(() => {})
    response.mockImplementation(async () => {
      started.resolve()
      return new Response(new ReadableStream({ cancel }))
    })
    const controller = new AbortController()
    const failure = validatePrivatemodeApiKey('unsaved-key', controller.signal).catch((error: unknown) => error)
    await started.promise
    await getClock().tickAsync(0)
    const reason = new DOMException('Validation interrupted', name)
    controller.abort(reason)
    expect(await failure).toBe(reason)
    expect(cancel).toHaveBeenCalled()
    expect(sdk.close).toHaveBeenCalledTimes(1)
  })

  it('rejects an already-cancelled validation before creating an SDK client', async () => {
    const create = spyOn(AttestedPrivatemodeClient, 'create')
    await expect(validatePrivatemodeApiKey('unsaved-key', AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('public OpenAI transport bridge', () => {
  it('keeps raw SSE bytes and response headers, and strips caller credentials and headers', async () => {
    const { sdk, response } = setup()
    const body = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'
    response.mockResolvedValue(new Response(body, { headers: { 'x-request-id': 'trace' } }))
    const result = await createPrivatemodeFetch(sdk)(apiURL, {
      ...request,
      headers: { authorization: 'Bearer caller-key', 'X-Proxy-Passthrough-Secret': 'sensitive' },
    })
    expect(await result.text()).toBe(body)
    expect(result.headers.get('x-request-id')).toBe('trace')
    expect(sdk.request.mock.calls[0][0]).toMatchObject({
      path: '/chat/completions',
      method: 'post',
      body: { model: 'test', messages: [], stream: true },
      maxRetries: 0,
    })
    expect(sdk.request.mock.calls[0][0]).not.toHaveProperty('headers')
  })

  it.each([
    'https://evil.example/v1/chat/completions',
    'https://api.privatemode.ai/v1/responses',
    'https://api.privatemode.ai/v1/chat/completions?override=1',
  ])('rejects unsupported destinations without touching the SDK: %s', async (url) => {
    const { sdk } = setup()
    expect((await createPrivatemodeFetch(sdk)(url, request)).status).toBe(400)
    expect(sdk.request).not.toHaveBeenCalled()
  })

  it('preserves API errors as HTTP responses rather than false verification failures', async () => {
    const { client, response, snapshot } = setup()
    const error = { message: 'Rate limited', type: 'rate_limit_error' }
    response.mockRejectedValue(new PrivatemodeAI.APIError(429, error, undefined, new Headers({ 'retry-after': '2' })))
    const result = await client.fetch(apiURL, request)
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).toBe('2')
    expect(await result.json()).toEqual({ error })
    expect(snapshot().status).toBe('verified')
    await client.close()
  })
})
