/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { AttestationError, RouterHTTPClient, EnclaveHTTPClient } from 'tinfoil'
import { getClock } from '@/testing-library'
import { testTinfoilVerification } from '@/test-utils/tinfoil'
import { createAttestationStore } from './store'
import { AttestedTinfoilClient, readTinfoilEvidence, type TinfoilVerification } from './tinfoil'

/** Exercise the public SDK surface, without installing state into private vendor fields. */
const setup = () => {
  const store = createAttestationStore()
  const proof = testTinfoilVerification()
  const sdk = {
    baseURL: 'https://router.tinfoil.sh/',
    enclave: 'router.tinfoil.sh',
    ensureVerified: mock(async () => proof),
    fetch: mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('result')),
    close: mock(async () => {}),
    get current(): never {
      throw new Error('Unchecked current evidence must never be used')
    },
  }
  const reporter = store.open('test')
  const client = new AttestedTinfoilClient(sdk, reporter, 1_000)
  return { client, sdk, proof, reporter, snapshot: () => store.getSnapshot('test') }
}
afterEach(() => mock.restore())

describe('Tinfoil v3 evidence', () => {
  it('copies only public verification facts and preserves the verifier timestamp', () => {
    const proof = testTinfoilVerification('secret-hpke-key', {
      metadata: {
        verifiedAt: new Date('2026-11-10T12:00:00Z'),
        verifier: { name: 'Verifier', version: '2' },
      },
    })
    const result = readTinfoilEvidence(proof, 'router.tinfoil.sh')
    expect(result.checks).toEqual(['hardware', 'code', 'measurement', 'channel'])
    expect(result.endpoint).toBe('router.tinfoil.sh')
    expect(result.verifiedAt).toBe(Date.parse('2026-11-10T12:00:00Z'))
    expect(JSON.stringify(result)).not.toContain('secret-hpke-key')
    expect(result.details).toContainEqual({ label: 'release', value: proof.codeDigest })
  })

  it('keeps the same evidence on cache reuse, then expires it before another request', async () => {
    const { client, sdk, proof, snapshot } = setup()
    await client.ensureVerified()
    const first = snapshot()
    await getClock().tickAsync(500)
    await client.ensureVerified()
    expect(snapshot()).toBe(first)
    await getClock().tickAsync(59_500)
    expect(snapshot()).toEqual({ status: 'idle' })
    const next = testTinfoilVerification()
    sdk.ensureVerified.mockResolvedValue(next)
    await client.ensureVerified()
    expect(snapshot()).toMatchObject({
      status: 'verified',
      evidence: { verifiedAt: next.metadata.verifiedAt.getTime() },
    })
    expect(next.metadata.verifiedAt.getTime()).toBeGreaterThan(proof.metadata.verifiedAt.getTime())
    await client.close()
  })
})

describe('observed SDK lifecycle', () => {
  it('blocks requests after rejected verification and preserves the original error', async () => {
    const { client, sdk, snapshot } = setup()
    const error = new AttestationError('hardware report rejected')
    sdk.ensureVerified.mockRejectedValue(error)
    await expect(client.fetch('https://router.tinfoil.sh/v1/chat/completions')).rejects.toBe(error)
    await expect(client.ensureVerified()).rejects.toBe(error)
    expect(sdk.fetch).not.toHaveBeenCalled()
    expect(sdk.close).toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it('shares a verification deadline and ignores a late success after timeout', async () => {
    const { client, sdk, snapshot } = setup()
    const pending = Promise.withResolvers<TinfoilVerification>()
    sdk.ensureVerified.mockImplementation(() => pending.promise)
    const first = client.ensureVerified()
    const result = first.catch((error: unknown) => error)
    expect(client.ensureVerified()).toBe(first)
    await getClock().tickAsync(1_000)
    expect(await result).toMatchObject({ name: 'TinfoilAttestationTimeoutError' })
    pending.resolve(testTinfoilVerification())
    await getClock().tickAsync(0)
    expect(snapshot()).toEqual({ status: 'failed', reason: 'timeout' })
    expect(sdk.close).toHaveBeenCalled()
    await expect(client.ensureVerified()).rejects.toMatchObject({ name: 'TinfoilAttestationTimeoutError' })
  })

  it('publishes replacement evidence only after the SDK fetch has bound rotated keys', async () => {
    const { client, sdk, snapshot } = setup()
    await client.ensureVerified()
    const next = testTinfoilVerification(undefined, { codeDigest: 'new-release' })
    sdk.fetch.mockImplementation(async () => {
      sdk.ensureVerified.mockResolvedValue(next)
      return new Response('rotated response')
    })
    expect(await (await client.fetch('https://router.tinfoil.sh/v1/chat/completions')).text()).toBe('rotated response')
    expect(snapshot()).toMatchObject({
      status: 'verified',
      evidence: { details: expect.arrayContaining([{ label: 'release', value: 'new-release' }]) },
    })
    await client.close()
  })

  it('retires a security failure during SDK-internal re-verification', async () => {
    const { client, sdk, snapshot } = setup()
    sdk.fetch.mockRejectedValue(new AttestationError('rejected rotated key'))
    await expect(client.fetch('https://router.tinfoil.sh/v1/chat/completions')).rejects.toThrow('rejected rotated key')
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
    expect(sdk.close).toHaveBeenCalled()
  })

  it('discards the response body if verification fails after its headers arrive', async () => {
    const { client, sdk, proof } = setup()
    const cancel = mock(() => {})
    sdk.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })))
    sdk.ensureVerified.mockResolvedValueOnce(proof).mockRejectedValue(new AttestationError('expired during request'))
    await expect(client.fetch('https://router.tinfoil.sh/v1/chat/completions')).rejects.toThrow(
      'expired during request',
    )
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['init', 'request'] as const)(
    'binds in-flight encrypted requests to close and caller cancellation: %s',
    async (source) => {
      const { client, sdk } = setup()
      const caller = new AbortController()
      const started = Promise.withResolvers<AbortSignal>()
      sdk.fetch.mockImplementation(async (_input, init) => {
        const signal = init!.signal!
        started.resolve(signal)
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      })
      const input =
        source === 'request'
          ? new Request('https://router.tinfoil.sh/v1/chat/completions', { signal: caller.signal })
          : 'https://router.tinfoil.sh/v1/chat/completions'
      const request = client
        .fetch(input, source === 'init' ? { signal: caller.signal } : undefined)
        .catch((error: unknown) => error)
      const signal = await started.promise
      expect(signal.aborted).toBe(false)
      await client.close()
      expect(signal.aborted).toBe(true)
      expect(await request).toHaveProperty('name', 'AbortError')
    },
  )

  it('aborts a streamed response that is still being consumed when the client closes', async () => {
    const { client, sdk } = setup()
    sdk.fetch.mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(stream) {
              init!.signal!.addEventListener('abort', () => stream.error(init!.signal!.reason), { once: true })
            },
          }),
        ),
    )
    const response = await client.fetch('https://router.tinfoil.sh/v1/chat/completions')
    const reading = response.text().catch((error: unknown) => error)
    await client.close()
    expect(await reading).toHaveProperty('name', 'AbortError')
  })

  it('closes and revokes evidence immediately, including verification that finishes later', async () => {
    const { client, sdk, snapshot } = setup()
    await client.ensureVerified()
    const pending = Promise.withResolvers<TinfoilVerification>()
    sdk.ensureVerified.mockImplementation(() => pending.promise)
    const result = client.ensureVerified().catch((error: unknown) => error)
    await client.close()
    pending.resolve(testTinfoilVerification())
    expect(await result).toHaveProperty('name', 'AbortError')
    expect(snapshot()).toEqual({ status: 'idle' })
    await getClock().tickAsync(60_000)
    expect(snapshot()).toEqual({ status: 'idle' })
  })

  it.each(['router', 'enclave'] as const)(
    'uses the public %s factory with EHBP and waits for key binding',
    async (kind) => {
      const { sdk, reporter, snapshot } = setup()
      const created = Promise.withResolvers<RouterHTTPClient>()
      const factory =
        kind === 'router'
          ? spyOn(RouterHTTPClient, 'create').mockImplementation(() => created.promise)
          : spyOn(EnclaveHTTPClient, 'create').mockImplementation(
              () => created.promise as unknown as Promise<EnclaveHTTPClient>,
            )
      const result = AttestedTinfoilClient.create(
        {
          userCacheSecret: 'test',
          ...(kind === 'enclave' ? { enclave: { host: sdk.enclave, repo: 'tinfoilsh/repo' } } : {}),
        },
        reporter,
        1_000,
      )
      const settings = (kind === 'router' ? factory.mock.calls[0][0] : factory.mock.calls[0][2]) as Parameters<
        typeof RouterHTTPClient.create
      >[0]
      expect(settings).toMatchObject({ transportMode: 'ehbp' })
      await settings!.verificationCheck!(testTinfoilVerification())
      expect(snapshot().status).toBe('verifying')
      created.resolve(sdk as unknown as RouterHTTPClient)
      const client = await result
      expect(client.baseURL).toBe(kind === 'router' ? 'https://router.tinfoil.sh/v1' : 'https://router.tinfoil.sh')
      expect(snapshot().status).toBe('verified')
      await client.close()
    },
  )

  it('releases a factory result that arrives after the initialization deadline', async () => {
    const { sdk, reporter, snapshot } = setup()
    const created = Promise.withResolvers<RouterHTTPClient>()
    spyOn(RouterHTTPClient, 'create').mockImplementation(() => created.promise)
    const result = AttestedTinfoilClient.create({}, reporter, 1_000).catch((error: unknown) => error)
    await getClock().tickAsync(1_000)
    expect(await result).toHaveProperty('name', 'TinfoilAttestationTimeoutError')
    created.resolve(sdk as unknown as RouterHTTPClient)
    await getClock().tickAsync(0)
    expect(sdk.close).toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'timeout' })
  })
})
