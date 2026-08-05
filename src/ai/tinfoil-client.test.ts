/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import type { SecureClient } from 'tinfoil'
import { createTinfoilClientLifecycle, isTinfoilTransportWedgedError } from './tinfoil-client'

/** Build the `SecureClient` slice consumed by the lifecycle. */
const createClient = (ready: () => Promise<void> = async () => {}): SecureClient =>
  ({
    ready,
    fetch: async () => new Response(),
    getBaseURL: () => 'https://enclave.example.com/v1/',
  }) as unknown as SecureClient

describe('Tinfoil client lifecycle', () => {
  it('wraps malformed attestation responses, preserves telemetry fidelity, and evicts the client', async () => {
    const readyError = new SyntaxError('Unexpected token in attestation document')
    const failedClient = createClient(async () => {
      throw readyError
    })
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => failedClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await expect(lifecycle.getSystemTinfoilClient()).rejects.toMatchObject({
      name: 'TinfoilAttestationError',
      message: 'Tinfoil attestation failed: SyntaxError: Unexpected token in attestation document',
      cause: readyError,
    })
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)

    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'error',
      duration_ms: 0,
      error_name: 'SyntaxError',
      client: 'system',
    })
  })

  it('times out hung ready, evicts the client, and reports timeout telemetry', async () => {
    const hungClient = createClient(() => new Promise<void>(() => {}))
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => hungClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      timeoutMs: 1_000,
      trackAttestation,
    })

    const clientPromise = lifecycle.getSystemTinfoilClient()
    const resultPromise = clientPromise.then(
      (client) => ({ client }),
      (error: unknown) => ({ error }),
    )
    await getClock().tickAsync(1_000)
    await expect(resultPromise).resolves.toMatchObject({
      error: {
        name: 'TinfoilAttestationTimeoutError',
        message: 'Tinfoil attestation timed out after 1000ms',
      },
    })

    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)
    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'timeout',
      duration_ms: 1_000,
      error_name: 'TinfoilAttestationTimeoutError',
      client: 'system',
    })
  })

  it('evicts a rejected construction promise', async () => {
    const constructionError = new Error('module load failed')
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => {
      throw constructionError
    })
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
    })

    await expect(lifecycle.getSystemTinfoilClient()).rejects.toBe(constructionError)
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)
    expect(createClientFactory).toHaveBeenCalledTimes(2)
  })

  it('shares one system-client construction across concurrent callers', async () => {
    const client = createClient()
    const createClientFactory = mock(async () => client)
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1/',
    })

    const [first, second] = await Promise.all([lifecycle.getSystemTinfoilClient(), lifecycle.getSystemTinfoilClient()])

    expect(first).toBe(client)
    expect(second).toBe(client)
    expect(createClientFactory).toHaveBeenCalledTimes(1)
    expect(createClientFactory).toHaveBeenCalledWith('system', 'https://cloud.example.com/v1')
  })

  it('tracks successful system attestation', async () => {
    const client = createClient()
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: async () => client,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await lifecycle.getSystemTinfoilClient()

    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'success',
      duration_ms: 0,
      client: 'system',
    })
  })

  it('reports success once per client instance while awaiting ready on every call', async () => {
    const ready = mock(async () => {})
    const client = createClient(ready)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: async () => client,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getSystemTinfoilClient()

    expect(ready).toHaveBeenCalledTimes(3)
    expect(trackAttestation).toHaveBeenCalledTimes(1)
  })

  it('times out and evicts when a later ready call hangs during re-attestation', async () => {
    const ready = mock(async (): Promise<void> => new Promise<void>(() => {}))
    ready.mockImplementationOnce(async () => {})
    const reattestingClient = createClient(ready)
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => reattestingClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      timeoutMs: 1_000,
      trackAttestation,
    })

    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(reattestingClient)
    const resultPromise = lifecycle.getSystemTinfoilClient().then(
      (client) => ({ client }),
      (error: unknown) => ({ error }),
    )
    await getClock().tickAsync(1_000)

    await expect(resultPromise).resolves.toMatchObject({
      error: { name: 'TinfoilAttestationTimeoutError' },
    })
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)
    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'timeout',
      duration_ms: 1_000,
      error_name: 'TinfoilAttestationTimeoutError',
      client: 'system',
    })
  })

  it('wraps unreachable attestation endpoints, tracks the underlying error, and evicts the client', async () => {
    const readyError = new TypeError('Failed to fetch')
    const failedClient = createClient(async () => {
      throw readyError
    })
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => failedClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await expect(lifecycle.getTinfoilClient()).rejects.toMatchObject({
      name: 'TinfoilAttestationError',
      message: 'Tinfoil attestation failed: TypeError: Failed to fetch',
      cause: readyError,
    })
    await expect(lifecycle.getTinfoilClient()).resolves.toBe(healthyClient)

    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(createClientFactory).toHaveBeenCalledWith('user', '')
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'error',
      duration_ms: 0,
      error_name: 'TypeError',
      client: 'user',
    })
  })
})

describe('isTinfoilTransportWedgedError', () => {
  it('matches SDK key-config mismatch errors by name', () => {
    const error = { name: 'KeyConfigMismatchError', message: 'key changed' }

    expect(isTinfoilTransportWedgedError(error)).toBe(true)
  })

  it('matches the SDK concurrent-reset null-transport TypeError', () => {
    const error = { name: 'TypeError', message: "Cannot read properties of null (reading 'fetch')" }

    expect(isTinfoilTransportWedgedError(error)).toBe(true)
  })

  it('does not classify unrelated errors for eviction', () => {
    expect(isTinfoilTransportWedgedError(new Error('network unavailable'))).toBe(false)
    expect(isTinfoilTransportWedgedError(new TypeError("Cannot read properties of null (reading 'baseURL')"))).toBe(
      false,
    )
  })
})
