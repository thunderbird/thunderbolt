/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { isIndexedDbAvailable, isPrPreview, prPreviewHostRegex } from './platform'

describe('prPreviewHostRegex', () => {
  it('matches thunderbolt-pr-{number}.onrender.com hostnames', () => {
    expect(prPreviewHostRegex.test('thunderbolt-pr-368.onrender.com')).toBe(true)
    expect(prPreviewHostRegex.test('thunderbolt-pr-1.onrender.com')).toBe(true)
    expect(prPreviewHostRegex.test('thunderbolt-pr-9999.onrender.com')).toBe(true)
  })

  it('rejects non-matching hostnames', () => {
    expect(prPreviewHostRegex.test('thunderbolt.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('thunderbolt-pr.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('thunderbolt-pr-368x.onrender.com')).toBe(false)
    expect(prPreviewHostRegex.test('localhost')).toBe(false)
    expect(prPreviewHostRegex.test('')).toBe(false)
  })
})

describe('isPrPreview', () => {
  const originalLocation = window.location

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    })
  })

  it('returns true when hostname matches PR preview pattern', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'thunderbolt-pr-368.onrender.com' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(true)
  })

  it('returns false when hostname does not match', () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, hostname: 'localhost' },
      configurable: true,
      writable: true,
    })
    expect(isPrPreview()).toBe(false)
  })
})

type FakeRequest = {
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onblocked: (() => void) | null
  result: { close: () => void }
}

/**
 * Builds a fake IDBFactory whose open() fires the requested handler on a
 * microtask (after the probe assigns onsuccess/onerror), plus a record of the
 * close() and deleteDatabase() calls the probe makes on success. The 'never'
 * outcome leaves the request unsettled so the probe's timeout guard can fire.
 */
const createFakeIdb = (outcome: 'success' | 'error' | 'throw' | 'never' | 'blocked') => {
  const calls = { close: 0, deleteDatabase: 0 }
  const idb = {
    open: (): FakeRequest => {
      if (outcome === 'throw') {
        throw new Error('open() blocked by lockdown mode')
      }
      const request: FakeRequest = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        result: {
          close: () => {
            calls.close += 1
          },
        },
      }
      if (outcome !== 'never') {
        queueMicrotask(() => {
          if (outcome === 'success') {
            request.onsuccess?.()
          } else if (outcome === 'blocked') {
            request.onblocked?.()
          } else {
            request.onerror?.()
          }
        })
      }
      return request
    },
    deleteDatabase: () => {
      calls.deleteDatabase += 1
    },
  } as unknown as IDBFactory
  return { idb, calls }
}

describe('isIndexedDbAvailable', () => {
  it('resolves true and cleans up the probe db when open() succeeds', async () => {
    const { idb, calls } = createFakeIdb('success')
    expect(await isIndexedDbAvailable(idb)).toBe(true)
    expect(calls.close).toBe(1)
    expect(calls.deleteDatabase).toBe(1)
  })

  it('resolves false when open() errors', async () => {
    const { idb } = createFakeIdb('error')
    expect(await isIndexedDbAvailable(idb)).toBe(false)
  })

  it('resolves false when open() is blocked', async () => {
    const { idb } = createFakeIdb('blocked')
    expect(await isIndexedDbAvailable(idb)).toBe(false)
  })

  it('resolves false when open() throws synchronously', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const { idb } = createFakeIdb('throw')
    expect(await isIndexedDbAvailable(idb)).toBe(false)
    warnSpy.mockRestore()
  })

  it('resolves false when the factory is missing', async () => {
    expect(await isIndexedDbAvailable(null)).toBe(false)
    expect(await isIndexedDbAvailable(undefined)).toBe(false)
  })

  it('resolves false when open() never settles (timeout guard)', async () => {
    const { idb } = createFakeIdb('never')
    const promise = isIndexedDbAvailable(idb)
    await getClock().tickAsync(5000)
    expect(await promise).toBe(false)
  })
})
