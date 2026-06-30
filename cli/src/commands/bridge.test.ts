/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the loopback bridge's upgrade gate — the control that
 * stops a drive-by web page from connecting to `ws://127.0.0.1:<port>` and
 * driving host RCE. Every path, origin, and token combination an attacker could
 * present must be rejected before `srv.upgrade`; only an allowlisted origin with
 * the exact per-run token may pass.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { authorizeUpgrade, bridgeAllowedOrigins, generateBridgeToken } from './bridge.ts'

const TOKEN = generateBridgeToken()
const ORIGINS = bridgeAllowedOrigins()

/** Build an upgrade request at the given path/query with an optional Origin. */
const upgradeRequest = (path: string, origin?: string): Request =>
  new Request(`http://127.0.0.1:8839${path}`, origin === undefined ? undefined : { headers: { origin } })

describe('authorizeUpgrade', () => {
  test('accepts an allowlisted origin with the exact token', () => {
    const req = upgradeRequest(`/?token=${TOKEN}`, 'http://localhost:1420')
    expect(authorizeUpgrade(req, TOKEN, ORIGINS)).toEqual({ ok: true })
  })

  test('accepts every built-in app origin', () => {
    for (const origin of ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost']) {
      const req = upgradeRequest(`/?token=${TOKEN}`, origin)
      expect(authorizeUpgrade(req, TOKEN, ORIGINS).ok).toBe(true)
    }
  })

  test('rejects a missing Origin header (non-browser / drive-by client)', () => {
    const req = upgradeRequest(`/?token=${TOKEN}`)
    expect(authorizeUpgrade(req, TOKEN, ORIGINS)).toEqual({ ok: false, status: 403, reason: "forbidden origin '(none)'" })
  })

  test('rejects an off-allowlist origin even with the correct token', () => {
    const req = upgradeRequest(`/?token=${TOKEN}`, 'https://evil.example')
    const decision = authorizeUpgrade(req, TOKEN, ORIGINS)
    expect(decision).toEqual({ ok: false, status: 403, reason: "forbidden origin 'https://evil.example'" })
  })

  test('rejects a missing token from an allowlisted origin', () => {
    const req = upgradeRequest('/', 'http://localhost:1420')
    expect(authorizeUpgrade(req, TOKEN, ORIGINS)).toEqual({ ok: false, status: 401, reason: 'missing or invalid token' })
  })

  test('rejects a wrong token of equal length', () => {
    const wrong = 'f'.repeat(TOKEN.length)
    const req = upgradeRequest(`/?token=${wrong}`, 'http://localhost:1420')
    expect(authorizeUpgrade(req, TOKEN, ORIGINS)).toEqual({ ok: false, status: 401, reason: 'missing or invalid token' })
  })

  test('rejects a token of the wrong length (constant-time compare guard)', () => {
    const req = upgradeRequest('/?token=short', 'http://localhost:1420')
    expect(authorizeUpgrade(req, TOKEN, ORIGINS).ok).toBe(false)
  })

  test('rejects any non-root path even with valid origin and token', () => {
    const req = upgradeRequest(`/admin?token=${TOKEN}`, 'http://localhost:1420')
    expect(authorizeUpgrade(req, TOKEN, ORIGINS)).toEqual({ ok: false, status: 404, reason: 'unknown path (only / is bridged)' })
  })
})

describe('generateBridgeToken', () => {
  test('is 256 bits of hex and unique per call', () => {
    const a = generateBridgeToken()
    const b = generateBridgeToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('bridgeAllowedOrigins', () => {
  afterEach(() => {
    delete process.env.THUNDERBOLT_APP_ORIGIN
  })

  test('contains the built-in origins and nothing else by default', () => {
    delete process.env.THUNDERBOLT_APP_ORIGIN
    expect([...bridgeAllowedOrigins()].sort()).toEqual(
      ['http://localhost:1420', 'http://tauri.localhost', 'tauri://localhost'].sort(),
    )
  })

  test('adds comma-separated origins from THUNDERBOLT_APP_ORIGIN, trimming blanks', () => {
    process.env.THUNDERBOLT_APP_ORIGIN = 'https://app.thunderbolt.example, , https://beta.example'
    const origins = bridgeAllowedOrigins()
    expect(origins.has('https://app.thunderbolt.example')).toBe(true)
    expect(origins.has('https://beta.example')).toBe(true)
    expect(origins.has('')).toBe(false)
  })
})
