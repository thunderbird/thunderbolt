/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import type { Page, Request } from 'playwright'
import { collectNetwork } from './network'

/** Emit Playwright lifecycle events while controlling only transport measurements. */
const fixture = () => {
  const listeners = new Map<string, (request: Request) => void>()
  const page = {
    on: (event: string, listener: (request: Request) => void) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
  } as unknown as Page
  const request = {
    url: () => 'http://fixture.test/chunk.js',
    method: () => 'GET',
    resourceType: () => 'script',
    response: async () => ({ status: () => 200, headers: () => ({ 'content-length': '99999' }) }),
    sizes: async () => ({ responseBodySize: 120, responseHeadersSize: 80 }),
    timing: () => ({ startTime: Date.now(), responseEnd: 75 }),
  } as unknown as Request
  return { page, request, listeners, emit: (event: string, value = request) => listeners.get(event)?.(value) }
}

it('measures completed request timing and actual transfer bytes instead of content-length', async () => {
  const f = fixture()
  const recorder = collectNetwork(f.page)
  f.emit('response')
  f.emit('requestfinished')
  expect(await recorder.finish()).toEqual([
    {
      url: 'http://fixture.test/chunk.js',
      method: 'GET',
      status: 200,
      resourceType: 'script',
      transferSizeBytes: 200,
      durationMs: 75,
      renderBlocking: true,
    },
  ])
  expect(f.listeners.size).toBe(0)
})

it('captures no-response failures alongside successful requests to the same URL', async () => {
  const f = fixture()
  const recorder = collectNetwork(f.page)
  f.emit('requestfinished')
  f.emit('requestfailed')
  const samples = await recorder.finish()
  expect(samples.map(({ status }) => status).sort()).toEqual([0, 200])
  expect(samples.find(({ status }) => status === 0)).toMatchObject({ transferSizeBytes: 0, renderBlocking: true })
  f.emit('requestfailed')
  expect(samples.length).toBe(2)
})

it('waits for outstanding measurement work and surfaces failures instead of reporting healthy metrics', async () => {
  const f = fixture()
  const size = Promise.withResolvers<{ responseBodySize: number; responseHeadersSize: number }>()
  const request = { ...f.request, sizes: () => size.promise } as Request
  const recorder = collectNetwork(f.page)
  f.emit('requestfinished', request)
  const result = recorder.finish()
  size.reject(new Error('transport measurement unavailable'))
  await expect(result).rejects.toThrow('Network measurement failed')
})

it.each([true, false])('handles failed requests with transport start timing present=%s', async (hasStart) => {
  const f = fixture()
  const recorder = collectNetwork(f.page)
  const request = {
    ...f.request,
    timing: () => ({ startTime: hasStart ? Date.now() - 25 : -1, responseEnd: -1 }),
  } as Request
  f.emit('requestfailed', request)
  const [sample] = await recorder.finish()
  if (hasStart) {
    expect(sample.durationMs).toBeGreaterThanOrEqual(25)
    expect(sample.durationMs).toBeLessThan(1000)
  } else {
    expect(sample.durationMs).toBe(0)
  }
})
