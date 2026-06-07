/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { Model } from '@/types'
import type { SecureClient, VerificationDocument } from 'tinfoil'
import { useTinfoilVerification } from './use-tinfoil-verification'

// Real providers (HttpClient + DB + react-query) so useHttpClient /
// useIntegrationStatus resolve normally — no module mocks that would leak into
// other test files in the same bun process. The enclave attestation is the only
// thing stubbed, via the injectable getActiveTinfoilClient.
beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(() => {
  cleanup()
})

const tinfoilModel = (overrides?: Partial<Model>) =>
  createMockModel({ provider: 'tinfoil', isSystem: 1, isConfidential: 1, ...overrides })

const fakeClient = (securityVerified: boolean) =>
  ({
    getVerificationDocument: () => ({ securityVerified }) as unknown as VerificationDocument,
  }) as unknown as SecureClient

const renderVerification = (model: Model | null, getClient: (m: Model) => Promise<SecureClient>) =>
  renderHook(() => useTinfoilVerification(model, getClient), { wrapper: createQueryTestWrapper() })

const flush = () =>
  act(async () => {
    await getClock().tickAsync(1)
  })

describe('useTinfoilVerification', () => {
  it('stays idle for a non-Tinfoil model and never attests', () => {
    const getClient = mock(async () => fakeClient(true))

    const { result } = renderVerification(createMockModel({ provider: 'openai' }), getClient)

    expect(result.current.status).toBe('idle')
    expect(result.current.doc).toBeNull()
    expect(getClient).not.toHaveBeenCalled()
  })

  it('stays idle for a confidential thunderbolt-provider model (e.g. GPT OSS)', () => {
    const getClient = mock(async () => fakeClient(true))

    const { result } = renderVerification(createMockModel({ provider: 'thunderbolt', isConfidential: 1 }), getClient)

    expect(result.current.status).toBe('idle')
    expect(getClient).not.toHaveBeenCalled()
  })

  it('resolves to verified and exposes the document', async () => {
    const getClient = mock(async () => fakeClient(true))

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()

    expect(getClient).toHaveBeenCalled()
    expect(result.current.status).toBe('verified')
    expect(result.current.doc?.securityVerified).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('marks failed when the enclave is not securityVerified', async () => {
    const getClient = mock(async () => fakeClient(false))

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()

    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe('Enclave verification failed')
  })

  it('retries with backoff then fails when attestation keeps throwing', async () => {
    const getClient = mock(async () => {
      throw new Error('attestation unreachable')
    })

    const { result } = renderVerification(tinfoilModel(), getClient)

    await act(async () => {
      // Exceeds the summed exponential backoff (~26s) for all attempts.
      await getClock().tickAsync(60_000)
    })

    // 6 attempts (0..maxRetries) per effect run; React may double-invoke the
    // effect under StrictMode, so assert the floor rather than an exact count.
    expect(getClient.mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe('attestation unreachable')
  })

  it('re-attests when retry() is called', async () => {
    let verified = false
    const getClient = mock(async () => fakeClient(verified))

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()
    expect(result.current.status).toBe('failed')

    const callsBeforeRetry = getClient.mock.calls.length
    verified = true
    act(() => result.current.retry())
    await flush()

    expect(result.current.status).toBe('verified')
    expect(getClient.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
  })

  it('resets to verifying immediately when switching to another Tinfoil model (fail-closed)', async () => {
    const getClient = mock(async () => fakeClient(true))
    const wrapper = createQueryTestWrapper()

    const { result, rerender } = renderHook(({ m }) => useTinfoilVerification(m, getClient), {
      wrapper,
      initialProps: { m: tinfoilModel({ id: 'model-a' }) },
    })
    await flush()
    expect(result.current.status).toBe('verified')

    rerender({ m: tinfoilModel({ id: 'model-b' }) })
    // Synchronous reset on model change — before the effect re-attests — so a
    // send can't slip through on the previous model's verified status.
    expect(result.current.status).toBe('verifying')

    await flush()
    expect(result.current.status).toBe('verified')
  })

  it('fails (not stuck verifying) after exhausting retries while offline', async () => {
    const onLine = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      const getClient = mock(async () => fakeClient(true))

      const { result } = renderVerification(tinfoilModel(), getClient)
      await act(async () => {
        await getClock().tickAsync(60_000)
      })

      expect(getClient).not.toHaveBeenCalled()
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('No network connection')
    } finally {
      if (onLine) {
        Object.defineProperty(navigator, 'onLine', onLine)
      }
    }
  })
})
