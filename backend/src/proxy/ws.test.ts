/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { classifyWsCloseCode, parseTargetSubprotocol, validateWsTarget, wsCloseCodes } from './ws'

describe('parseTargetSubprotocol', () => {
  it('extracts target from base64url subprotocol entry', () => {
    const target = 'wss://upstream.test/path?q=1'
    const encoded = Buffer.from(target).toString('base64url')
    const result = parseTargetSubprotocol(`tbproxy.target.${encoded}`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.target).toBe(target)
      expect(result.callerProtocols).toEqual([])
    }
  })

  it('strips all tbproxy.* entries and preserves caller protocols', () => {
    const encoded = Buffer.from('wss://upstream.test/').toString('base64url')
    const result = parseTargetSubprotocol(`tbproxy.target.${encoded}, acp.v1, tbproxy.something-else, json`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.callerProtocols).toEqual(['acp.v1', 'json'])
    }
  })

  it('rejects when no tbproxy.target.* entry is present', () => {
    const result = parseTargetSubprotocol('acp.v1, json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('missing')
    }
  })

  it('rejects when there are multiple tbproxy.target.* entries', () => {
    const enc = Buffer.from('wss://a.test/').toString('base64url')
    const result = parseTargetSubprotocol(`tbproxy.target.${enc}, tbproxy.target.${enc}`)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('duplicate')
    }
  })

  it('rejects malformed base64url', () => {
    const result = parseTargetSubprotocol('tbproxy.target.')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('malformed')
    }
  })
})

describe('validateWsTarget', () => {
  it('accepts wss://public-host', () => {
    const r = validateWsTarget('wss://upstream.test/path')
    expect(r.ok).toBe(true)
  })

  it('rejects ws:// (plaintext)', () => {
    const r = validateWsTarget('ws://upstream.test/path')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('wss-only')
    }
  })

  it('rejects wss://localhost', () => {
    const r = validateWsTarget('wss://localhost/path')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('private-host')
    }
  })

  it('rejects wss://127.0.0.1', () => {
    const r = validateWsTarget('wss://127.0.0.1/path')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('private-host')
    }
  })

  it('rejects wss://10.0.0.1 (RFC1918 private range)', () => {
    const r = validateWsTarget('wss://10.0.0.1/path')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('private-host')
    }
  })
})

describe('classifyWsCloseCode', () => {
  it('maps invalidSubprotocol (4002) to invalid_target', () => {
    expect(classifyWsCloseCode(wsCloseCodes.invalidSubprotocol)).toBe('invalid_target')
  })

  it('maps schemeRejected (4003) to invalid_target', () => {
    // Pre-upgrade rejection: included so future code paths that close with 4003
    // post-upgrade categorise consistently with the 4002 sibling.
    expect(classifyWsCloseCode(wsCloseCodes.schemeRejected)).toBe('invalid_target')
  })

  it('maps queueOverflow (4008) to cap_exceeded', () => {
    expect(classifyWsCloseCode(wsCloseCodes.queueOverflow)).toBe('cap_exceeded')
  })

  it('maps internalError (1011) to upstream_5xx', () => {
    expect(classifyWsCloseCode(wsCloseCodes.internalError)).toBe('upstream_5xx')
  })

  it('returns undefined for clean closes (1000, 1001)', () => {
    expect(classifyWsCloseCode(1000)).toBeUndefined()
    expect(classifyWsCloseCode(1001)).toBeUndefined()
  })

  it('returns undefined for upstream-propagated app codes (4321)', () => {
    // Upstream-defined close codes pass through but stay uncategorised — only
    // proxy-initiated closes have a known semantic category.
    expect(classifyWsCloseCode(4321)).toBeUndefined()
  })
})
