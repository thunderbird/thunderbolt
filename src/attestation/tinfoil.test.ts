/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SecureClient, type VerificationDocument } from 'tinfoil'
import { KeyConfigMismatchError } from 'ehbp'
import { getClock } from '@/testing-library'
import { createAttestationStore } from './store'
import { AttestedTinfoilClient, readTinfoilEvidence } from './tinfoil'

/** A successful SDK document, independent of UI state. */
const verificationDocument = (enclaveHost = 'router.tinfoil.sh'): VerificationDocument => ({
  configRepo: 'tinfoilsh/confidential-model-router',
  enclaveHost,
  releaseDigest: 'a'.repeat(64),
  codeMeasurement: { type: 'sev-snp', registers: ['b'.repeat(96)] },
  enclaveMeasurement: { measurement: { type: 'sev-snp', registers: ['b'.repeat(96)] } },
  tlsPublicKey: 'tls-key',
  hpkePublicKey: 'hpke-key',
  codeFingerprint: 'b'.repeat(96),
  enclaveFingerprint: 'b'.repeat(96),
  selectedRouterEndpoint: enclaveHost,
  securityVerified: true,
  steps: {
    fetchDigest: { status: 'success' },
    verifyCode: { status: 'success' },
    verifyEnclave: { status: 'success' },
    compareMeasurements: { status: 'success' },
    verifyCertificate: { status: 'success' },
  },
})

/** Install SDK-derived state without network I/O; actual ready/reset/fetch dispatch stays intact. */
const setSdkState = (client: SecureClient, document: VerificationDocument, fetch: () => Promise<Response>) => {
  Object.defineProperties(client, {
    verificationDocument: { value: document, writable: true },
    _transport: { value: { fetch }, writable: true },
  })
}

/** Construct a production adapter with an isolated observer. */
const setup = () => {
  const store = createAttestationStore()
  const client = new AttestedTinfoilClient({ userCacheSecret: 'test' }, store.open('test'), 1_000)
  return { client, snapshot: () => store.getSnapshot('test') }
}

afterEach(() => mock.restore())

describe('Tinfoil evidence', () => {
  it('copies only public, provider-neutral evidence', () => {
    const result = readTinfoilEvidence(verificationDocument())
    expect(result.checks).toEqual(['hardware', 'code', 'measurement', 'channel'])
    expect(result.endpoint).toBe('router.tinfoil.sh')
    expect(JSON.stringify(result)).not.toContain('hpke-key')
    expect(JSON.stringify(result)).not.toContain('tls-key')
  })

  it.each(['fetchDigest', 'verifyCode', 'verifyEnclave', 'compareMeasurements', 'verifyCertificate'] as const)(
    'rejects an incomplete or failed %s even if securityVerified is true',
    (step) => {
      const document = verificationDocument()
      document.steps[step] = { status: 'pending' }
      expect(() => readTinfoilEvidence(document)).toThrow('incomplete')
      document.steps[step] = { status: 'failed', error: 'failed' }
      expect(() => readTinfoilEvidence(document)).toThrow('incomplete')
    },
  )

  it('requires the channel binding and a successful overall verification', () => {
    const document = verificationDocument()
    delete document.steps.verifyCertificate
    expect(() => readTinfoilEvidence(document)).toThrow('incomplete')
    expect(() => readTinfoilEvidence({ ...verificationDocument(), securityVerified: false })).toThrow('incomplete')
  })

  it.each(['enclaveHost', 'releaseDigest', 'enclaveFingerprint'] as const)(
    'rejects successful checks without their %s identity',
    (field) => {
      expect(() => readTinfoilEvidence({ ...verificationDocument(), [field]: '' })).toThrow('incomplete')
    },
  )

  it('rejects a document with an additional SDK failure', () => {
    const document = verificationDocument()
    document.steps.otherError = { status: 'failed', error: 'transport failed' }
    expect(() => readTinfoilEvidence(document)).toThrow('incomplete')
  })
})

describe('observed SDK lifecycle', () => {
  it('keeps the original verification time on reuse and clears evidence on reset', async () => {
    const { client, snapshot } = setup()
    const document = verificationDocument()
    const ready = spyOn(SecureClient.prototype, 'ready').mockImplementation(async () => {
      setSdkState(
        client,
        document,
        mock(async () => new Response()),
      )
    })
    await client.ready()
    const initial = snapshot()
    expect(initial.status).toBe('verified')
    await getClock().tickAsync(60_000)
    await client.ready()
    expect(snapshot()).toBe(initial)
    expect(ready).toHaveBeenCalledTimes(1)
    client.reset()
    expect(snapshot()).toEqual({ status: 'idle' })
  })

  it('follows SDK key rotation through the real fetch retry and reports the replacement enclave', async () => {
    const { client, snapshot } = setup()
    const firstFetch = mock(async () => {
      throw new KeyConfigMismatchError('rotated')
    })
    const nextFetch = mock(async () => new Response('encrypted response'))
    const ready = spyOn(SecureClient.prototype, 'ready')
    ready.mockImplementationOnce(async () => {
      setSdkState(client, verificationDocument('one.tinfoil.sh'), firstFetch)
    })
    ready.mockImplementationOnce(async () => {
      expect(snapshot().status).toBe('verifying')
      setSdkState(client, verificationDocument('two.tinfoil.sh'), nextFetch)
    })
    const response = await client.fetch('https://cloud/v1/chat/completions', { method: 'POST', body: 'prompt' })
    expect(await response.text()).toBe('encrypted response')
    expect(snapshot()).toMatchObject({ status: 'verified', evidence: { endpoint: 'two.tinfoil.sh' } })
    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(nextFetch).toHaveBeenCalledTimes(1)
  })

  it('blocks fetch when ready returns incomplete evidence', async () => {
    const { client, snapshot } = setup()
    const fetch = mock(async () => new Response())
    spyOn(SecureClient.prototype, 'ready').mockImplementation(async () => {
      setSdkState(client, { ...verificationDocument(), securityVerified: false }, fetch)
    })
    await expect(client.fetch('https://cloud/v1/chat/completions')).rejects.toThrow('incomplete')
    expect(fetch).not.toHaveBeenCalled()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it('reports failure even when the SDK resets itself before rejecting', async () => {
    const { client, snapshot } = setup()
    spyOn(SecureClient.prototype, 'ready').mockImplementation(async () => {
      client.reset()
      throw new Error('hardware verification failed')
    })
    await expect(client.ready()).rejects.toThrow('hardware verification failed')
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })

  it('bounds re-attestation and ignores a late SDK completion after timeout', async () => {
    const { client, snapshot } = setup()
    const pending = Promise.withResolvers<void>()
    const ready = spyOn(SecureClient.prototype, 'ready').mockImplementation(() => pending.promise)
    const first = client.ready()
    const result = first.catch((error: unknown) => error)
    expect(snapshot().status).toBe('verifying')
    await getClock().tickAsync(500)
    const second = client.ready()
    expect(second).toBe(first)
    await getClock().tickAsync(500)
    expect(await result).toMatchObject({ name: 'TinfoilAttestationTimeoutError' })
    setSdkState(
      client,
      verificationDocument(),
      mock(async () => new Response()),
    )
    pending.resolve()
    await getClock().tickAsync(0)
    expect(snapshot()).toEqual({ status: 'failed', reason: 'timeout' })
    client.reset()
    await expect(client.ready()).rejects.toMatchObject({ name: 'TinfoilAttestationTimeoutError' })
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('retires an SDK reset during initialization before its old transport can send a request', async () => {
    const { client, snapshot } = setup()
    const pending = Promise.withResolvers<void>()
    const fetch = mock(async () => new Response('must not be sent'))
    const ready = spyOn(SecureClient.prototype, 'ready').mockImplementation(async () => {
      await pending.promise
      setSdkState(client, verificationDocument('stale.tinfoil.sh'), fetch)
    })
    const result = client.fetch('https://cloud/v1/chat/completions').catch((error: unknown) => error)
    client.reset()
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
    await expect(client.ready()).rejects.toThrow('reset before it completed')
    pending.resolve()
    expect(await result).toMatchObject({ name: 'TinfoilAttestationError' })
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
    expect(fetch).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('keeps the original SDK failure when the SDK resets before rejecting', async () => {
    const { client, snapshot } = setup()
    const error = new Error('invalid hardware report')
    spyOn(SecureClient.prototype, 'ready').mockImplementation(async () => {
      await Promise.resolve()
      client.reset()
      throw error
    })
    await expect(client.ready()).rejects.toBe(error)
    await expect(client.ready()).rejects.toBe(error)
    expect(snapshot()).toEqual({ status: 'failed', reason: 'verification' })
  })
})
