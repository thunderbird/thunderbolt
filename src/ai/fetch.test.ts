/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'bun:test'
import { resetProxyFetchCacheForTests, getOrCreateProxyFetch } from './fetch'

// Web defaults — `isStandalone` returns false, so `proxy_enabled` is forced on
// and the storage read never matters. Tauri tests explicitly flip both knobs.
const webDeps = { isStandalone: () => false, readProxyEnabled: () => null }

describe('getOrCreateProxyFetch', () => {
  beforeEach(() => {
    resetProxyFetchCacheForTests()
  })

  it('returns the same fetch reference when called with the same cloudUrl', () => {
    const first = getOrCreateProxyFetch('http://a.example/v1', webDeps)
    const second = getOrCreateProxyFetch('http://a.example/v1', webDeps)
    expect(second).toBe(first)
  })

  it('returns a different fetch reference when cloudUrl changes', () => {
    const first = getOrCreateProxyFetch('http://a.example/v1', webDeps)
    const second = getOrCreateProxyFetch('http://b.example/v1', webDeps)
    expect(second).not.toBe(first)
  })

  it('reuses the new entry for the most recent cloudUrl, evicting the previous one lazily', () => {
    const a1 = getOrCreateProxyFetch('http://a.example/v1', webDeps)
    const b1 = getOrCreateProxyFetch('http://b.example/v1', webDeps)
    const b2 = getOrCreateProxyFetch('http://b.example/v1', webDeps)
    const a2 = getOrCreateProxyFetch('http://a.example/v1', webDeps)
    expect(b2).toBe(b1)
    // Cache holds at most one entry, so re-requesting `a` after switching to `b`
    // must rebuild the fetch — verifies lazy eviction is happening.
    expect(a2).not.toBe(a1)
  })

  describe('proxy_enabled toggle', () => {
    it('Tauri: rebuilds the cached fetch when proxy_enabled flips (cache key includes the toggle)', () => {
      // Off → cache miss, build, store.
      const off = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => true,
        readProxyEnabled: () => 'false',
      })
      // On → cache miss again because the effective value changed.
      const on = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => true,
        readProxyEnabled: () => 'true',
      })
      expect(on).not.toBe(off)
      // Re-requesting with the same key as last call should be a cache hit.
      const onAgain = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => true,
        readProxyEnabled: () => 'true',
      })
      expect(onAgain).toBe(on)
    })

    it('Web: ignores the storage value (effective is always true), so cache stays warm across reads', () => {
      const first = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => false,
        readProxyEnabled: () => 'false',
      })
      const second = getOrCreateProxyFetch('http://a.example/v1', {
        // Storage flipped to 'true' — irrelevant on Web; effective stays true.
        isStandalone: () => false,
        readProxyEnabled: () => 'true',
      })
      expect(second).toBe(first)
    })

    it('Tauri default (storage absent): effective proxy_enabled is false', () => {
      // Two reads with absent storage should produce the same cached fetch.
      const first = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => true,
        readProxyEnabled: () => null,
      })
      const second = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => true,
        readProxyEnabled: () => null,
      })
      expect(second).toBe(first)

      // Flipping storage to 'true' must invalidate the cache.
      const flipped = getOrCreateProxyFetch('http://a.example/v1', {
        isStandalone: () => true,
        readProxyEnabled: () => 'true',
      })
      expect(flipped).not.toBe(first)
    })
  })
})
