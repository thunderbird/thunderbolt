/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, mock, test } from 'bun:test'
import { fetchReleaseSnapshot, getReleaseSnapshot } from './release-snapshot'
import fallback from '../data/download-release.json'
import { parseRelease } from '../components/marketing/download/downloads'

const originalFetch = globalThis.fetch
const stable = { tag_name: 'v2.0.0', draft: false, prerelease: false, assets: [] }
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('build pages share one validated release lookup', async () => {
  globalThis.fetch = mock(async () => Response.json(stable)) as unknown as typeof fetch
  const [first, second] = await Promise.all([getReleaseSnapshot(), getReleaseSnapshot()])
  expect(first).toEqual(stable)
  expect(second).toBe(first)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
})

test.each([new Response('', { status: 403 }), Response.json({}), Response.json({ ...stable, prerelease: true })])(
  'invalid or unavailable upstream metadata retains the stable fallback',
  async (response) => {
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch
    expect(await fetchReleaseSnapshot()).toEqual(fallback)
    expect(Object.keys(parseRelease(fallback).downloads).length).toBeGreaterThan(0)
  },
)

test('offline or timed-out builds retain the stable fallback', async () => {
  globalThis.fetch = mock(async () => {
    throw new TypeError('Network unavailable')
  }) as unknown as typeof fetch
  expect(await fetchReleaseSnapshot()).toEqual(fallback)
})
