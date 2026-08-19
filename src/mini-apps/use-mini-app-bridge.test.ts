/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { miniAppProtocolMarker } from '@shared/mini-app-protocol'
import { acceptGuestMessage } from './use-mini-app-bridge'

/** Stand-ins for `Window`; identity is all `acceptGuestMessage` compares. */
const frameWindow = { name: 'frame' } as unknown as Window
const otherWindow = { name: 'other' } as unknown as Window

const origin = 'http://localhost:5174'

const message = {
  jsonrpc: '2.0',
  protocol: miniAppProtocolMarker,
  method: 'context/update',
  params: { context: { title: 'Q3', summary: 'Revenue model.' } },
}

const event = (overrides: Partial<{ source: Window | null; origin: string; data: unknown }> = {}) => ({
  source: frameWindow,
  origin,
  data: message,
  ...overrides,
})

describe('acceptGuestMessage', () => {
  it('accepts a message from the right window and origin', () => {
    const accepted = acceptGuestMessage(event(), { expectedWindow: frameWindow, expectedOrigin: origin })
    expect(accepted?.method).toBe('context/update')
  })

  // Source and origin are independent gates. Origin alone would trust a
  // different frame on the same host; source alone would keep trusting our
  // frame after it navigated somewhere else.
  it('rejects a message from a different window on the correct origin', () => {
    const accepted = acceptGuestMessage(event({ source: otherWindow }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  it('rejects a message from the right window on a different origin', () => {
    const accepted = acceptGuestMessage(event({ origin: 'http://evil.example' }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  it('rejects everything before the frame has a contentWindow', () => {
    const accepted = acceptGuestMessage(event(), { expectedWindow: null, expectedOrigin: origin })
    expect(accepted).toBeNull()
  })

  it('rejects a null source', () => {
    const accepted = acceptGuestMessage(event({ source: null }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  it('rejects a malformed payload even from a trusted window and origin', () => {
    const accepted = acceptGuestMessage(event({ data: { hello: 'world' } }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })

  // Origins compare exactly — a prefix match would accept
  // `http://localhost:51740`, and a suffix match an attacker-chosen subdomain.
  it('does not accept an origin that merely shares a prefix', () => {
    const accepted = acceptGuestMessage(event({ origin: 'http://localhost:51740' }), {
      expectedWindow: frameWindow,
      expectedOrigin: origin,
    })
    expect(accepted).toBeNull()
  })
})
