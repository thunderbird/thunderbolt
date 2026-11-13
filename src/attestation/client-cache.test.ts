/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createAttestedClientCache, revokeAttestedConnection } from './client-cache'
import { createAttestationStore } from './store'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import type { AttestationReporter } from './types'

const makeClient = () => ({
  baseURL: 'https://provider.example/v1',
  fetch: mock(async () => new Response('ok')),
  ensureVerified: mock(async () => {}),
  close: mock(() => {}),
})

describe('attested client cache', () => {
  it('revokes only clients bound to the changed credential connection', async () => {
    const store = createAttestationStore()
    const cache = createAttestedClientCache({
      key: (id: string) => `provider:${id}`,
      connectionId: (id) => id,
      create: async () => makeClient(),
      attestations: store,
    })
    const first = await cache.acquire('one')
    const second = await cache.acquire('two')
    revokeAttestedConnection('one')
    await Promise.resolve()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(store.getSnapshot('provider:one').status).toBe('idle')
    expect(await cache.acquire('two')).toBe(second)
    expect(await cache.acquire('one')).not.toBe(first)
    cache.clear()
  })
  it('shares concurrent construction but replaces clients when credentials change', async () => {
    const store = createAttestationStore()
    const create = mock(async () => makeClient())
    const cache = createAttestedClientCache({
      key: (_request: { key: string }) => 'provider:connection',
      sameRequest: (previous, next) => previous.key === next.key,
      create,
      attestations: store,
    })
    const [one, two] = await Promise.all([cache.acquire({ key: 'first' }), cache.acquire({ key: 'first' })])
    expect(one).toBe(two)
    expect(create).toHaveBeenCalledTimes(1)
    const replacement = await cache.acquire({ key: 'next' })
    expect(replacement).not.toBe(one)
    expect(one.close).toHaveBeenCalledTimes(1)
    cache.evict({ key: 'first' }, one)
    expect(await cache.acquire({ key: 'next' })).toBe(replacement)
    cache.clear()
  })

  it('retires failed clients and ignores late evidence from an old reporter', async () => {
    const store = createAttestationStore()
    const reporters: AttestationReporter[] = []
    const cache = createAttestedClientCache({
      key: () => 'provider:connection',
      create: async (_request: string, reporter) => {
        reporters.push(reporter)
        return makeClient()
      },
      attestations: store,
    })
    const first = await cache.acquire('first')
    reporters[0].publish({ status: 'failed', reason: 'verification' })
    expect(store.getSnapshot('provider:connection').status).toBe('failed')
    const next = await cache.acquire('next')
    expect(next).not.toBe(first)
    reporters[0].publish({ status: 'failed', reason: 'timeout' })
    expect(store.getSnapshot('provider:connection').status).toBe('verifying')
    cache.clear()
  })

  it('cancels pending acquisition on logout and closes a client that resolves late', async () => {
    const store = createAttestationStore()
    const pending = Promise.withResolvers<ReturnType<typeof makeClient>>()
    const cache = createAttestedClientCache({
      key: () => 'provider:connection',
      create: async () => pending.promise,
      attestations: store,
    })
    const acquisition = cache.acquire('connection')
    await Promise.resolve()
    invalidateIdentityLifetime()
    const client = makeClient()
    pending.resolve(client)
    await expect(acquisition).rejects.toThrow()
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(client.ensureVerified).not.toHaveBeenCalled()
    expect(store.getSnapshot('provider:connection').status).toBe('idle')
    cache.clear()
  })
})
