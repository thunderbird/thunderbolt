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

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { BridgeProc } from './bridge.ts'
import {
  atProcCapacity,
  authorizeUpgrade,
  bridgeAllowedOrigins,
  forwardFrameToStdin,
  generateBridgeToken,
  hostForUrl,
  maxActiveProcs,
  minConfiguredTokenLength,
  resolveBridgeHost,
  resolveBridgeToken,
} from './bridge.ts'

const token = generateBridgeToken()
const origins = bridgeAllowedOrigins()

/** Build an upgrade request at the given path/query with an optional Origin. */
const upgradeRequest = (path: string, origin?: string): Request =>
  new Request(`http://127.0.0.1:8839${path}`, origin === undefined ? undefined : { headers: { origin } })

describe('authorizeUpgrade', () => {
  test('accepts an allowlisted origin with the exact token', () => {
    const req = upgradeRequest(`/?token=${token}`, 'http://localhost:1420')
    expect(authorizeUpgrade(req, token, origins)).toEqual({ ok: true })
  })

  test('accepts every built-in app origin', () => {
    for (const origin of ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost']) {
      const req = upgradeRequest(`/?token=${token}`, origin)
      expect(authorizeUpgrade(req, token, origins).ok).toBe(true)
    }
  })

  test('rejects a missing Origin header (non-browser / drive-by client)', () => {
    const req = upgradeRequest(`/?token=${token}`)
    expect(authorizeUpgrade(req, token, origins)).toEqual({
      ok: false,
      status: 403,
      reason: "forbidden origin '(none)'",
    })
  })

  test('rejects an off-allowlist origin even with the correct token', () => {
    const req = upgradeRequest(`/?token=${token}`, 'https://evil.example')
    const decision = authorizeUpgrade(req, token, origins)
    expect(decision).toEqual({ ok: false, status: 403, reason: "forbidden origin 'https://evil.example'" })
  })

  test('rejects a missing token from an allowlisted origin', () => {
    const req = upgradeRequest('/', 'http://localhost:1420')
    expect(authorizeUpgrade(req, token, origins)).toEqual({
      ok: false,
      status: 401,
      reason: 'missing or invalid token',
    })
  })

  test('rejects a wrong token of equal length', () => {
    const wrong = 'f'.repeat(token.length)
    const req = upgradeRequest(`/?token=${wrong}`, 'http://localhost:1420')
    expect(authorizeUpgrade(req, token, origins)).toEqual({
      ok: false,
      status: 401,
      reason: 'missing or invalid token',
    })
  })

  test('rejects a token of the wrong length (constant-time compare guard)', () => {
    const req = upgradeRequest('/?token=short', 'http://localhost:1420')
    expect(authorizeUpgrade(req, token, origins).ok).toBe(false)
  })

  test('rejects any non-root path even with valid origin and token', () => {
    const req = upgradeRequest(`/admin?token=${token}`, 'http://localhost:1420')
    expect(authorizeUpgrade(req, token, origins)).toEqual({
      ok: false,
      status: 404,
      reason: 'unknown path (only / is bridged)',
    })
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

describe('atProcCapacity — shared live-subprocess cap', () => {
  const procs = (n: number): Set<BridgeProc> => new Set(Array.from({ length: n }, () => ({}) as BridgeProc))

  test('allows work below the ceiling and refuses at or above it', () => {
    expect(atProcCapacity(procs(0))).toBe(false)
    expect(atProcCapacity(procs(maxActiveProcs - 1))).toBe(false)
    expect(atProcCapacity(procs(maxActiveProcs))).toBe(true)
    expect(atProcCapacity(procs(maxActiveProcs + 1))).toBe(true)
  })
})

describe('forwardFrameToStdin', () => {
  let stderr: ReturnType<typeof spyOn>
  beforeEach(() => {
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderr.mockRestore()
  })

  /** A fake subprocess whose stdin write/flush are controllable. */
  const fakeProc = (flush: () => Promise<number>): { proc: BridgeProc; write: ReturnType<typeof mock> } => {
    const write = mock(() => 1)
    return { proc: { stdin: { write, flush } } as unknown as BridgeProc, write }
  }

  test('appends the ndjson newline, writes, and awaits the flush; never closes on success', async () => {
    const { proc, write } = fakeProc(async () => 0)
    const close = mock((_code: number, _reason: string) => {})
    await forwardFrameToStdin(proc, '{"jsonrpc":"2.0"}', close)
    expect(write.mock.calls[0][0]).toBe('{"jsonrpc":"2.0"}\n')
    expect(close).not.toHaveBeenCalled()
  })

  test('logs loudly and closes 1011 when the flush fails (EPIPE on a dead pipe)', async () => {
    const { proc } = fakeProc(async () => {
      throw new Error('EPIPE')
    })
    const close = mock((_code: number, _reason: string) => {})
    await forwardFrameToStdin(proc, 'frame', close)
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toBe(1011)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0][0])).toContain('stdin write failed')
  })

  test('closes 1011 when the synchronous write itself throws', async () => {
    const flush = mock(async () => 0)
    const proc = {
      stdin: {
        write: mock(() => {
          throw new Error('write blew up')
        }),
        flush,
      },
    } as unknown as BridgeProc
    const close = mock((_code: number, _reason: string) => {})
    await forwardFrameToStdin(proc, 'frame', close)
    expect(flush).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toBe(1011)
  })
})

describe('deployment configuration', () => {
  test('generates a token when none is configured', () => {
    expect(resolveBridgeToken({}).length).toBe(64)
    expect(resolveBridgeToken({ THUNDERBOLT_BRIDGE_TOKEN: '' }).length).toBe(64)
  })

  test('uses an operator-supplied token so a restart does not break clients', () => {
    const token = 'a'.repeat(minConfiguredTokenLength)
    expect(resolveBridgeToken({ THUNDERBOLT_BRIDGE_TOKEN: token })).toBe(token)
  })

  test('refuses a short token at startup rather than serving with it', () => {
    expect(() => resolveBridgeToken({ THUNDERBOLT_BRIDGE_TOKEN: 'short' })).toThrow('at least')
  })

  test('binds loopback unless an operator opts out', () => {
    expect(resolveBridgeHost({})).toBe('127.0.0.1')
    expect(resolveBridgeHost({ THUNDERBOLT_BRIDGE_HOST: '' })).toBe('127.0.0.1')
  })

  test('accepts a public bind that also configures a stable token', () => {
    const env = { THUNDERBOLT_BRIDGE_HOST: '0.0.0.0', THUNDERBOLT_BRIDGE_TOKEN: 'a'.repeat(32) }
    expect(resolveBridgeHost(env)).toBe('0.0.0.0')
  })

  test('refuses a public bind with no stable token', () => {
    // The Dockerfile ships THUNDERBOLT_BRIDGE_HOST=0.0.0.0, so without this a
    // bare `docker run` publishes a process that spawns agents behind a secret
    // that only ever reached this process's stdout and changes every restart.
    expect(() => resolveBridgeHost({ THUNDERBOLT_BRIDGE_HOST: '0.0.0.0' })).toThrow('requires THUNDERBOLT_BRIDGE_TOKEN')
    expect(() => resolveBridgeHost({ THUNDERBOLT_BRIDGE_HOST: '0.0.0.0', THUNDERBOLT_BRIDGE_TOKEN: '' })).toThrow(
      'requires THUNDERBOLT_BRIDGE_TOKEN',
    )
  })

  test.each(['127.0.0.1', '::1', 'localhost'])('needs no token to pin loopback explicitly (%s)', (host) => {
    // Spelling out the default is not opting out of it, so demanding a token
    // here would be a confusing no-op.
    expect(resolveBridgeHost({ THUNDERBOLT_BRIDGE_HOST: host })).toBe(host)
  })

  test('names the offending address so the error is actionable', () => {
    expect(() => resolveBridgeHost({ THUNDERBOLT_BRIDGE_HOST: '10.0.0.5' })).toThrow('10.0.0.5')
  })

  test('still rejects a public bind whose token is too short', () => {
    // resolveBridgeToken owns the length floor; this only checks the two guards
    // compose rather than one masking the other.
    expect(resolveBridgeHost({ THUNDERBOLT_BRIDGE_HOST: '0.0.0.0', THUNDERBOLT_BRIDGE_TOKEN: 'short' })).toBe('0.0.0.0')
    expect(() => resolveBridgeToken({ THUNDERBOLT_BRIDGE_TOKEN: 'short' })).toThrow('at least')
  })
})

describe('hostForUrl', () => {
  test('brackets an IPv6 literal so the advertised URL parses', () => {
    // `ws://::1:8839` is not a URL, and this one is meant to be pasted into the
    // app verbatim.
    expect(new URL(`ws://${hostForUrl('::1')}:8839/`).hostname).toBe('[::1]')
    expect(hostForUrl('::')).toBe('[::]')
  })

  test('leaves names and IPv4 addresses alone', () => {
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1')
    expect(hostForUrl('0.0.0.0')).toBe('0.0.0.0')
    expect(hostForUrl('localhost')).toBe('localhost')
  })

  test('does not double-bracket a value the operator already bracketed', () => {
    expect(hostForUrl('[::1]')).toBe('[::1]')
  })
})

describe('public bind relaxes the origin allowlist but never the token', () => {
  // The app's own universal WS proxy dials with `new WebSocket(url, protocols)`
  // and sends no Origin, so a hosted agent was unreachable from the web app:
  // the browser cannot connect direct (it is forced through the proxy) and the
  // proxy cannot satisfy an origin check. Verified against a live bridge before
  // changing this — no-Origin closed 1002, allowlisted Origin opened.
  const upgrade = (headers: Record<string, string>, query = `?token=${token}`) =>
    new Request(`http://127.0.0.1:8839/${query}`, { headers })

  test('accepts a proxy-shaped connection with no Origin', () => {
    expect(authorizeUpgrade(upgrade({}), token, origins, true)).toEqual({ ok: true })
  })

  test('accepts an Origin that is not on the allowlist', () => {
    // Not a loosening worth mourning: anything reaching a public bind is a
    // server, and a server sets whatever Origin it likes.
    expect(authorizeUpgrade(upgrade({ Origin: 'https://anything.example' }), token, origins, true)).toEqual({
      ok: true,
    })
  })

  test('still rejects a missing or wrong token', () => {
    expect(authorizeUpgrade(upgrade({}, ''), token, origins, true)).toEqual({
      ok: false,
      status: 401,
      reason: 'missing or invalid token',
    })
    expect(authorizeUpgrade(upgrade({}, '?token=nope'), token, origins, true)).toEqual({
      ok: false,
      status: 401,
      reason: 'missing or invalid token',
    })
  })

  test('still rejects a path other than /', () => {
    const req = new Request(`http://127.0.0.1:8839/elsewhere?token=${token}`)
    expect(authorizeUpgrade(req, token, origins, true).ok).toBe(false)
  })

  test('loopback still demands an allowlisted Origin', () => {
    // The default path, unchanged: a drive-by page in the user's own browser is
    // the threat the allowlist exists for.
    expect(authorizeUpgrade(upgrade({}), token, origins, false)).toEqual({
      ok: false,
      status: 403,
      reason: "forbidden origin '(none)'",
    })
  })
})
