/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, afterEach } from 'bun:test'
import { createWsTicketStore, WsTicketStoreFullError } from './ws-ticket-store'

/** Build a store with a controllable clock so we can test expiry deterministically. */
const buildStore = (initial = 1_000_000) => {
  let clock = initial
  const advance = (ms: number) => {
    clock += ms
  }
  const store = createWsTicketStore({
    now: () => clock,
    sweepIntervalMs: 60_000,
    maxActive: 5,
    // Tests never want a leftover interval lingering across files.
    unrefInterval: true,
  })
  return { store, advance }
}

const created: Array<ReturnType<typeof buildStore>['store']> = []
const track = <T extends ReturnType<typeof buildStore>['store']>(s: T): T => {
  created.push(s)
  return s
}

afterEach(() => {
  for (const s of created.splice(0)) {
    s.shutdown()
  }
})

describe('createWsTicketStore', () => {
  it('issueTicket returns a high-entropy base64url nonce', () => {
    const { store } = buildStore()
    track(store)
    const t1 = store.issueTicket('user-1', 'haystack', 30_000)
    const t2 = store.issueTicket('user-1', 'haystack', 30_000)
    // 32 bytes base64url ≈ 43 chars; allow ±1 for any padding quirks.
    expect(t1.length).toBeGreaterThanOrEqual(42)
    expect(t1.length).toBeLessThanOrEqual(44)
    // Two issuances must not collide — astronomical probability with 256 bits, but assert anyway.
    expect(t1).not.toBe(t2)
    // Charset must be URL-safe base64.
    expect(/^[A-Za-z0-9_-]+$/.test(t1)).toBe(true)
  })

  it('consumeTicket returns userId on first use and null on every subsequent use', () => {
    const { store } = buildStore()
    track(store)
    const ticket = store.issueTicket('user-1', 'haystack', 30_000)
    const first = store.consumeTicket(ticket, 'haystack')
    expect(first).toEqual({ userId: 'user-1' })
    const second = store.consumeTicket(ticket, 'haystack')
    expect(second).toBeNull()
  })

  it('consumeTicket returns null for expired tickets', () => {
    const { store, advance } = buildStore()
    track(store)
    const ticket = store.issueTicket('user-1', 'haystack', 30_000)
    advance(30_001)
    expect(store.consumeTicket(ticket, 'haystack')).toBeNull()
  })

  it('consumeTicket returns null when the scope does not match', () => {
    const { store } = buildStore()
    track(store)
    const ticket = store.issueTicket('user-1', 'haystack', 30_000)
    // 'proxy' is a sibling scope — consuming with the wrong scope must fail.
    expect(store.consumeTicket(ticket, 'proxy')).toBeNull()
    // And scope mismatch still consumes the entry — defense against replay.
    expect(store.consumeTicket(ticket, 'haystack')).toBeNull()
  })

  it('issueTicket + consumeTicket round-trips correctly for the proxy scope', () => {
    const { store } = buildStore()
    track(store)
    const ticket = store.issueTicket('user-1', 'proxy', 30_000)
    expect(store.consumeTicket(ticket, 'proxy')).toEqual({ userId: 'user-1' })
    expect(store.consumeTicket(ticket, 'proxy')).toBeNull()
  })

  it('consumeTicket returns null for an unknown nonce', () => {
    const { store } = buildStore()
    track(store)
    expect(store.consumeTicket('totally-made-up', 'haystack')).toBeNull()
  })

  it('refuses new tickets when at capacity and the existing ones have not expired', () => {
    const { store } = buildStore()
    track(store)
    for (let i = 0; i < 5; i++) {
      store.issueTicket(`user-${i}`, 'haystack', 30_000)
    }
    expect(() => store.issueTicket('user-x', 'haystack', 30_000)).toThrow(WsTicketStoreFullError)
  })

  it('makes room by sweeping expired tickets when at capacity', () => {
    const { store, advance } = buildStore()
    track(store)
    for (let i = 0; i < 5; i++) {
      store.issueTicket(`user-${i}`, 'haystack', 30_000)
    }
    advance(30_001)
    const fresh = store.issueTicket('user-x', 'haystack', 30_000)
    expect(typeof fresh).toBe('string')
    expect(store.size()).toBe(1)
  })

  it('clearForTesting empties the store', () => {
    const { store } = buildStore()
    track(store)
    store.issueTicket('user-1', 'haystack', 30_000)
    store.issueTicket('user-2', 'haystack', 30_000)
    expect(store.size()).toBe(2)
    store.clearForTesting()
    expect(store.size()).toBe(0)
  })
})
