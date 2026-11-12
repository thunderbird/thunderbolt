/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { onlineManager, QueryClient } from '@tanstack/react-query'
import { getClock } from '@/testing-library'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import * as discovery from './capabilities'
import { clearOtariCapabilityCache, loadCachedOtariWebCapabilities } from './capability-query'

const connection = { id: 'oauth:otari', url: 'https://otari.example/api/v1', revision: 'first-authorization' }
const available = { search: 'available', fetch: 'available' } as const
const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
const load = (
  signal = new AbortController().signal,
  identity: Parameters<typeof loadCachedOtariWebCapabilities>[0] = connection,
  key = 'secret-api-key',
) => loadCachedOtariWebCapabilities(identity, key, signal, client)

beforeEach(() => {
  spyOn(discovery, 'loadOtariWebCapabilities').mockResolvedValue(available)
})
afterEach(() => {
  client.clear()
  mock.restore()
})

it('shares recent discovery without retaining provider credentials in cache keys or values', async () => {
  expect(await load()).toEqual(available)
  expect(await load()).toEqual(available)
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(1)
  const cached = client.getQueryCache().getAll()
  expect(cached).toHaveLength(1)
  expect(JSON.stringify(cached.map(({ queryKey, state }) => [queryKey, state.data]))).not.toContain('secret-api-key')
})

it('attempts local discovery even when the browser reports being offline', async () => {
  const wasOnline = onlineManager.isOnline()
  onlineManager.setOnline(false)
  try {
    const local = { ...connection, url: 'http://localhost:8099/api/v1' }
    const pending = load(undefined, local)
    expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(1)
    expect(await pending).toEqual(available)
  } finally {
    onlineManager.setOnline(wasOnline)
  }
})

it('does not cache legacy credentials without an authorization generation', async () => {
  const legacy = { ...connection, revision: undefined }
  await load(undefined, legacy)
  await load(undefined, legacy, 'replacement-secret')
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(2)
  expect(client.getQueryCache().getAll()).toEqual([])
})

it('refreshes a known capability snapshot after thirty seconds', async () => {
  expect(await load()).toEqual(available)
  getClock().tick(29_999)
  expect(await load()).toEqual(available)
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(1)
  getClock().tick(1)
  expect(await load()).toEqual(available)
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(2)
})

it.each(['not_configured', 'workspace_disabled'] as const)(
  'retains known %s without assuming search is available',
  async (status) => {
    spyOn(discovery, 'loadOtariWebCapabilities').mockResolvedValue({ search: status, fetch: status })
    expect((await load()).search).toBe(status)
    expect((await load()).search).toBe(status)
    expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(1)
  },
)

it.each(['search', 'fetch'] as const)('retries unknown %s on the next turn', async (tool) => {
  spyOn(discovery, 'loadOtariWebCapabilities')
    .mockResolvedValueOnce({ ...available, [tool]: 'unknown' })
    .mockResolvedValue(available)
  expect((await load())[tool]).toBe('unknown')
  expect(await load()).toEqual(available)
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(2)
})

it.each([
  { ...connection, revision: 'reconnected-same-url' },
  { ...connection, url: 'https://another.example/api/v1' },
  { ...connection, id: 'another-connection' },
])('does not reuse a different connection authorization: %j', async (changed) => {
  await load()
  await load(undefined, changed)
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(2)
})

it('deduplicates concurrent settings and send discovery without sharing caller cancellation', async () => {
  const pending = Promise.withResolvers<discovery.OtariWebCapabilities>()
  const started = Promise.withResolvers<AbortSignal>()
  spyOn(discovery, 'loadOtariWebCapabilities').mockImplementation(async (_url, _key, signal) => {
    started.resolve(signal)
    return pending.promise
  })
  const settings = new AbortController()
  const settingsRequest = load(settings.signal)
  const requestSignal = await started.promise
  const sendRequest = load()
  settings.abort()
  expect(requestSignal.aborted).toBe(false)
  pending.resolve(available)
  await expect(settingsRequest).rejects.toHaveProperty('name', 'AbortError')
  expect(await sendRequest).toEqual(available)
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(1)
})

it('rejects an already-cancelled consumer without starting discovery', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(load(controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  expect(discovery.loadOtariWebCapabilities).not.toHaveBeenCalled()
})

it('aborts shared discovery and clears cached results during identity teardown', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  spyOn(discovery, 'loadOtariWebCapabilities').mockImplementation(
    async (_url, _key, signal) =>
      new Promise((_resolve, reject) => {
        started.resolve(signal)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
  )
  const request = load()
  const signal = await started.promise
  invalidateIdentityLifetime()
  clearOtariCapabilityCache(client)
  expect(signal.aborted).toBe(true)
  await expect(request).rejects.toThrow()
  expect(client.getQueryCache().getAll()).toEqual([])
  spyOn(discovery, 'loadOtariWebCapabilities').mockResolvedValue(available)
  expect(await load()).toEqual(available)
})

it('clears settled capabilities too, including the same connection in the next identity', async () => {
  await load()
  invalidateIdentityLifetime()
  clearOtariCapabilityCache(client)
  await load()
  expect(discovery.loadOtariWebCapabilities).toHaveBeenCalledTimes(2)
})
