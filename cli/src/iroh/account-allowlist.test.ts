/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the account-scoped allowlist: the credential-fetched, in-memory
 * cache of the account's trusted NodeIds. Covers the wire contract (URL, auth header
 * per credential kind, body parsing), the cache swap on refresh, the soft-fail on a
 * transient fetch error (keep last-known-good, never throw), and self-revocation
 * (the bridge's own NodeId dropping out of a populated list disables auto-trust).
 * The fetch seam is injected — no network.
 */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import type { BridgeCredential } from '../auth/token-store.ts'
import {
  createAccountAllowlist,
  fetchAccountAllowlist,
  registerBridgeWithBackend,
  type FetchFn,
} from './account-allowlist.ts'

/** Build a bridge credential for the wire tests; defaults to a device-grant session. */
const cred = (overrides: Partial<BridgeCredential> = {}): BridgeCredential => ({
  cloudUrl: 'https://api.test/v1',
  token: 'signed.jwt',
  kind: 'session',
  ...overrides,
})

/** Build a JSON `Response` for the injected fetch. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('fetchAccountAllowlist — wire contract', () => {
  it('GETs /devices/allowlist with the session bearer and returns the node ids', async () => {
    const seen: { url: string; auth: string | null; apiKey: string | null } = { url: '', auth: null, apiKey: null }
    const fetchFn: FetchFn = async (url, init) => {
      seen.url = url
      seen.auth = new Headers(init?.headers).get('authorization')
      seen.apiKey = new Headers(init?.headers).get('x-api-key')
      return jsonResponse({ nodeIds: [{ nodeId: 'peer-a' }, { nodeId: 'peer-b' }] })
    }

    const ids = await fetchAccountAllowlist(cred({ token: 'signed.jwt' }), fetchFn)

    expect(seen.url).toBe('https://api.test/v1/devices/allowlist')
    expect(seen.auth).toBe('Bearer signed.jwt')
    expect(seen.apiKey).toBeNull() // a session never sends x-api-key
    expect(ids).toEqual(['peer-a', 'peer-b'])
  })

  it('sends the PAT via x-api-key (not Authorization) for an api-key credential', async () => {
    const seen: { auth: string | null; apiKey: string | null } = { auth: null, apiKey: null }
    const fetchFn: FetchFn = async (_url, init) => {
      seen.auth = new Headers(init?.headers).get('authorization')
      seen.apiKey = new Headers(init?.headers).get('x-api-key')
      return jsonResponse({ nodeIds: [] })
    }

    await fetchAccountAllowlist(cred({ token: 'pat-xyz', kind: 'apiKey' }), fetchFn)

    // The apiKey plugin authenticates ONLY via x-api-key — a bearer would 401.
    expect(seen.apiKey).toBe('pat-xyz')
    expect(seen.auth).toBeNull()
  })

  it('normalizes a cloud URL without /v1 before appending the path', async () => {
    let seenUrl = ''
    const fetchFn: FetchFn = async (url) => {
      seenUrl = url
      return jsonResponse({ nodeIds: [] })
    }

    await fetchAccountAllowlist(cred({ cloudUrl: 'https://api.test/' }), fetchFn)

    expect(seenUrl).toBe('https://api.test/v1/devices/allowlist')
  })

  it('drops rows with a null node id (nullable column, never-bound devices)', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ nodeIds: [{ nodeId: 'ok' }, { nodeId: null }] })
    expect(await fetchAccountAllowlist(cred(), fetchFn)).toEqual(['ok'])
  })

  it('throws on a non-2xx response so the caller can decide to soft-fail', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ error: 'unauthorized' }, 401)
    await expect(fetchAccountAllowlist(cred(), fetchFn)).rejects.toThrow(/401/)
  })

  it('passes an abort signal so a hung backend cannot block the fetch forever', async () => {
    const seen: { signal: AbortSignal | null } = { signal: null }
    const fetchFn: FetchFn = async (_url, init) => {
      seen.signal = init?.signal ?? null
      return jsonResponse({ nodeIds: [] })
    }

    await fetchAccountAllowlist(cred(), fetchFn, 5000)

    expect(seen.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('registerBridgeWithBackend — wire contract', () => {
  it('POSTs the bare NodeId and bridge name with the session bearer', async () => {
    const seen: {
      url: string
      method: string | undefined
      body: string | null | undefined
      auth: string | null
      signal: AbortSignal | null
    } = { url: '', method: undefined, body: undefined, auth: null, signal: null }
    const fetchFn: FetchFn = async (url, init) => {
      seen.url = url
      seen.method = init?.method
      seen.body = typeof init?.body === 'string' ? init.body : undefined
      seen.auth = new Headers(init?.headers).get('authorization')
      seen.signal = init?.signal ?? null
      return jsonResponse({ device: {} })
    }

    await registerBridgeWithBackend(cred(), 'bare-node-id', 'Workstation', fetchFn)

    expect(seen.url).toBe('https://api.test/v1/devices/bridge')
    expect(seen.method).toBe('POST')
    expect(seen.body).toBe(JSON.stringify({ nodeId: 'bare-node-id', name: 'Workstation' }))
    expect(seen.auth).toBe('Bearer signed.jwt')
    expect(seen.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports a revoked bridge on 409 and uses x-api-key for a PAT', async () => {
    const seen: { auth: string | null; apiKey: string | null } = { auth: null, apiKey: null }
    const fetchFn: FetchFn = async (_url, init) => {
      seen.auth = new Headers(init?.headers).get('authorization')
      seen.apiKey = new Headers(init?.headers).get('x-api-key')
      return jsonResponse({ error: 'Bridge device revoked' }, 409)
    }

    await expect(
      registerBridgeWithBackend(cred({ token: 'pat-xyz', kind: 'apiKey' }), 'bare-node-id', 'Bridge', fetchFn),
    ).rejects.toThrow(
      'this device was revoked on your account — remove it in Settings → Devices to pair again (manual allowlist still works)',
    )
    expect(seen.apiKey).toBe('pat-xyz')
    expect(seen.auth).toBeNull()
  })

  it('preserves the legacy 403 registration error', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ error: 'forbidden' }, 403)

    await expect(registerBridgeWithBackend(cred(), 'bare-node-id', 'Bridge', fetchFn)).rejects.toThrow(
      'bridge revoked on the account',
    )
  })

  it('surfaces network errors to the account-trust degradation boundary', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('network down')
    }

    await expect(registerBridgeWithBackend(cred(), 'bare-node-id', 'Bridge', fetchFn)).rejects.toThrow('network down')
  })
})

/** The bridge's own NodeId, included in the fetched list so cache tests aren't
 *  self-revoked (self-revocation is exercised in its own describe below). */
const selfNode = 'self-node'

describe('createAccountAllowlist — in-memory cache', () => {
  it('trusts no peer until the first successful refresh', () => {
    const allowlist = createAccountAllowlist(async () => [selfNode, 'peer'], selfNode)
    expect(allowlist.has('peer')).toBe(false)
  })

  it('starts from a successfully fetched startup prime', () => {
    const allowlist = createAccountAllowlist(async () => [], selfNode, [selfNode, 'peer'])
    expect(allowlist.has('peer')).toBe(true)
  })

  it('populates the cache on refresh and trims the queried id', async () => {
    const allowlist = createAccountAllowlist(async () => [selfNode, 'peer-a', 'peer-b'], selfNode)
    await allowlist.refresh()
    expect(allowlist.has('peer-a')).toBe(true)
    expect(allowlist.has('  peer-b  ')).toBe(true)
    expect(allowlist.has('stranger')).toBe(false)
  })

  it('replaces the cache on each refresh, so a revoked id drops out', async () => {
    let ids = [selfNode, 'peer-a', 'peer-b']
    const allowlist = createAccountAllowlist(async () => ids, selfNode)
    await allowlist.refresh()
    expect(allowlist.has('peer-b')).toBe(true)

    ids = [selfNode, 'peer-a'] // peer-b revoked in the account
    await allowlist.refresh()
    expect(allowlist.has('peer-b')).toBe(false)
    expect(allowlist.has('peer-a')).toBe(true)
  })

  it('soft-fails a transient fetch error: keeps the last-known set and does not throw', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    let fail = false
    const allowlist = createAccountAllowlist(async () => {
      if (fail) throw new Error('network down')
      return [selfNode, 'peer-a']
    }, selfNode)

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
    const allowlist = createAccountAllowlist(fetchFn, selfNode)

    await allowlist.refresh()

    expect(allowlist.has('anyone')).toBe(false)
    stderr.mockRestore()
  })
})

describe('createAccountAllowlist — self-revocation', () => {
  it('trusts no account peer once this bridge is dropped from a populated allowlist', async () => {
    // The populated list omits selfNode → the account revoked this bridge.
    const allowlist = createAccountAllowlist(async () => ['peer-a', 'peer-b'], selfNode)
    await allowlist.refresh()

    expect(allowlist.isSelfRevoked()).toBe(true)
    expect(allowlist.has('peer-a')).toBe(false) // account auto-trust disabled
    expect(allowlist.has('peer-b')).toBe(false)
  })

  it('keeps trusting peers while this bridge is still listed', async () => {
    const allowlist = createAccountAllowlist(async () => [selfNode, 'peer-a'], selfNode)
    await allowlist.refresh()

    expect(allowlist.isSelfRevoked()).toBe(false)
    expect(allowlist.has('peer-a')).toBe(true)
  })

  it('treats an empty allowlist as unknown, never self-revoked (unprimed / fetch failure)', async () => {
    const allowlist = createAccountAllowlist(async () => [], selfNode)
    await allowlist.refresh()

    expect(allowlist.isSelfRevoked()).toBe(false) // empty ≠ revoked, so auto-trust isn't disabled on a blip
    expect(allowlist.has('anyone')).toBe(false)
  })

  it('re-trusts once this bridge returns to the allowlist (re-keyed / re-attested)', async () => {
    let ids = ['peer-a'] // selfNode absent → revoked
    const allowlist = createAccountAllowlist(async () => ids, selfNode)
    await allowlist.refresh()
    expect(allowlist.isSelfRevoked()).toBe(true)

    ids = [selfNode, 'peer-a'] // this bridge re-added
    await allowlist.refresh()
    expect(allowlist.isSelfRevoked()).toBe(false)
    expect(allowlist.has('peer-a')).toBe(true)
  })
})
