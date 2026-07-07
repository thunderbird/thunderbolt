/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the account-scoped allowlist (D2): the bearer-fetched, in-memory cache
 * of the account's trusted NodeIds. Covers the wire contract (URL, bearer header,
 * body parsing), the cache swap on refresh, and the soft-fail on a transient fetch
 * error (keep last-known-good, never throw). The fetch seam is injected — no network.
 */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { createAccountAllowlist, fetchAccountAllowlist, type FetchFn } from './account-allowlist.ts'

/** Build a JSON `Response` for the injected fetch. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('fetchAccountAllowlist — wire contract', () => {
  it('GETs /devices/allowlist with the bearer and returns the node ids', async () => {
    const seen: { url: string; auth: string | null } = { url: '', auth: null }
    const fetchFn: FetchFn = async (url, init) => {
      seen.url = url
      seen.auth = new Headers(init?.headers).get('authorization')
      return jsonResponse({ nodeIds: [{ nodeId: 'peer-a' }, { nodeId: 'peer-b' }] })
    }

    const ids = await fetchAccountAllowlist('https://api.test/v1', 'signed.jwt', fetchFn)

    expect(seen.url).toBe('https://api.test/v1/devices/allowlist')
    expect(seen.auth).toBe('Bearer signed.jwt')
    expect(ids).toEqual(['peer-a', 'peer-b'])
  })

  it('strips a trailing slash from the cloud URL before appending the path', async () => {
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      seenUrl = url
      return jsonResponse({ nodeIds: [] })
    }

    await fetchAccountAllowlist('https://api.test/v1/', 'tok', fetchFn)

    expect(seenUrl).toBe('https://api.test/v1/devices/allowlist')
  })

  it('drops rows with a null node id (nullable column, never-bound devices)', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ nodeIds: [{ nodeId: 'ok' }, { nodeId: null }] })
    expect(await fetchAccountAllowlist('https://api.test/v1', 'tok', fetchFn)).toEqual(['ok'])
  })

  it('throws on a non-2xx response so the caller can decide to soft-fail', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ error: 'unauthorized' }, 401)
    await expect(fetchAccountAllowlist('https://api.test/v1', 'tok', fetchFn)).rejects.toThrow(/401/)
  })

  it('passes an abort signal so a hung backend cannot block the fetch forever', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null }
    const fetchFn: FetchFn = async (_url, init) => {
      seen.signal = init?.signal ?? null
      return jsonResponse({ nodeIds: [] })
    }

    await fetchAccountAllowlist('https://api.test/v1', 'tok', fetchFn, 5000)

    expect(seen.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('createAccountAllowlist — in-memory cache', () => {
  it('trusts no peer until the first successful refresh', () => {
    const allowlist = createAccountAllowlist(async () => ['peer'])
    expect(allowlist.has('peer')).toBe(false)
  })

  it('populates the cache on refresh and trims the queried id', async () => {
    const allowlist = createAccountAllowlist(async () => ['peer-a', 'peer-b'])
    await allowlist.refresh()
    expect(allowlist.has('peer-a')).toBe(true)
    expect(allowlist.has('  peer-b  ')).toBe(true)
    expect(allowlist.has('stranger')).toBe(false)
  })

  it('replaces the cache on each refresh, so a revoked id drops out', async () => {
    let ids = ['peer-a', 'peer-b']
    const allowlist = createAccountAllowlist(async () => ids)
    await allowlist.refresh()
    expect(allowlist.has('peer-b')).toBe(true)

    ids = ['peer-a'] // peer-b revoked in the account
    await allowlist.refresh()
    expect(allowlist.has('peer-b')).toBe(false)
    expect(allowlist.has('peer-a')).toBe(true)
  })

  it('soft-fails a transient fetch error: keeps the last-known set and does not throw', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    let fail = false
    const allowlist = createAccountAllowlist(async () => {
      if (fail) throw new Error('network down')
      return ['peer-a']
    })

    await allowlist.refresh()
    expect(allowlist.has('peer-a')).toBe(true)

    fail = true
    await allowlist.refresh() // must not throw
    expect(allowlist.has('peer-a')).toBe(true) // last-known-good preserved
    expect(stderr).toHaveBeenCalled()
    stderr.mockRestore()
  })

  it('leaves the cache empty (no peer trusted) when the very first refresh fails', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const fetchFn = mock(async () => {
      throw new Error('boom')
    })
    const allowlist = createAccountAllowlist(fetchFn)

    await allowlist.refresh()

    expect(allowlist.has('anyone')).toBe(false)
    stderr.mockRestore()
  })
})
