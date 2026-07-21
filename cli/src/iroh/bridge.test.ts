/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the iroh bridge's trust boundary and DoS backstops:
 *   - the allowlist gate (a non-allowlisted peer is closed, no agent spawned),
 *   - the handshake timeout/semaphore (a stalled handshake can't pin a slot),
 *   - the per-remote sliding-window rate limiter + bounded key map,
 *   - the rate-limit key derivation.
 * Native iroh connection/incoming objects are replaced by minimal fakes; the
 * allowlist is the real file store over a temp `THUNDERBOLT_HOME`.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { Connection, Incoming } from '@number0/iroh'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeConfig } from '../agent/types.ts'
import { maxActiveProcs, redactArgv, type BridgeProc } from '../commands/bridge.ts'
import { add } from './allowlist.ts'
import {
  admitConnection,
  closeRefused,
  createHandshakeGuard,
  createRateLimiter,
  handleConnection,
  handshake,
  remoteKey,
} from './bridge.ts'

/** UTF-8 bytes of a close reason, computed independently of `reasonBytes`. */
const bytesOf = (s: string): number[] => [...Buffer.from(s, 'utf8')]
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createRateLimiter — sliding window', () => {
  it('allows up to max within the window, then refuses', () => {
    const limiter = createRateLimiter(2, 1000, () => 0)
    expect(limiter.allow('peer')).toBe(true)
    expect(limiter.allow('peer')).toBe(true)
    expect(limiter.allow('peer')).toBe(false)
  })

  it('refills once the window slides past the old hits', () => {
    let t = 0
    const limiter = createRateLimiter(2, 1000, () => t)
    expect(limiter.allow('peer')).toBe(true)
    expect(limiter.allow('peer')).toBe(true)
    expect(limiter.allow('peer')).toBe(false)
    t = 1000
    expect(limiter.allow('peer')).toBe(true)
  })

  it('budgets each key independently', () => {
    const limiter = createRateLimiter(2, 1000, () => 0)
    limiter.allow('a')
    limiter.allow('a')
    expect(limiter.allow('a')).toBe(false)
    expect(limiter.allow('b')).toBe(true)
  })

  it('evicts the least-recently-seen key past the cap, resetting its budget', () => {
    const limiter = createRateLimiter(1, 1000, () => 0, 2)
    expect(limiter.allow('A')).toBe(true)
    expect(limiter.allow('A')).toBe(false) // A exhausted
    expect(limiter.allow('B')).toBe(true)
    expect(limiter.allow('C')).toBe(true) // map now {A,B,C}, size 3 > cap 2
    // Next touch of A evicts the oldest key (A itself) -> A's history is gone.
    expect(limiter.allow('A')).toBe(true)
  })

  it('does NOT reset an exhausted key while it stays within the cap', () => {
    const limiter = createRateLimiter(1, 1000, () => 0, 10)
    expect(limiter.allow('A')).toBe(true)
    expect(limiter.allow('A')).toBe(false)
    limiter.allow('B')
    limiter.allow('C')
    expect(limiter.allow('A')).toBe(false) // still exhausted, no eviction
  })
})

describe('createHandshakeGuard — concurrency cap', () => {
  it('grants up to max slots then refuses, and a release frees one', () => {
    const guard = createHandshakeGuard(2)
    expect(guard.tryAcquire()).toBe(true)
    expect(guard.tryAcquire()).toBe(true)
    expect(guard.tryAcquire()).toBe(false)
    guard.release()
    expect(guard.tryAcquire()).toBe(true)
  })

  it('never lets release push the count below zero (no phantom capacity)', () => {
    const guard = createHandshakeGuard(1)
    guard.release() // release with nothing in flight
    expect(guard.tryAcquire()).toBe(true)
    expect(guard.tryAcquire()).toBe(false)
  })
})

describe('remoteKey — rate-limit key derivation', () => {
  const fakeIncoming = (addr: { kind: string; addr?: string; endpointId?: string }): Incoming =>
    ({ remoteAddr: async () => addr }) as unknown as Incoming

  it('prefers the endpointId when present', async () => {
    expect(await remoteKey(fakeIncoming({ kind: 'relay', endpointId: 'EID', addr: '1.2.3.4:5' }))).toBe('EID')
  })

  it('falls back to the socket addr when no endpointId', async () => {
    expect(await remoteKey(fakeIncoming({ kind: 'direct', addr: '1.2.3.4:5' }))).toBe('1.2.3.4:5')
  })

  it('falls back to the transport kind when neither is present', async () => {
    expect(await remoteKey(fakeIncoming({ kind: 'mixed' }))).toBe('mixed')
  })
})

describe('handshake — timeout & guard release', () => {
  it('returns the connection and releases the guard exactly once on success', async () => {
    const connection = { close: mock(() => {}) } as unknown as Connection
    const incoming = { accept: async () => ({ connect: async () => connection }) } as unknown as Incoming
    const release = mock(() => {})
    const result = await handshake(incoming, { release }, 50)
    expect(result).toBe(connection)
    expect(release).toHaveBeenCalledTimes(1)
    expect(connection.close as ReturnType<typeof mock>).not.toHaveBeenCalled()
  })

  it('releases the guard exactly once and propagates when the handshake fails before the deadline', async () => {
    const boom = new Error('connect refused')
    const incoming = {
      accept: async () => ({
        connect: async () => {
          throw boom
        },
      }),
    } as unknown as Incoming
    const release = mock(() => {})
    await expect(handshake(incoming, { release }, 1000)).rejects.toBe(boom)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rejects on timeout, releases the slot, and closes a late-settling connection', async () => {
    let resolveConn: (c: Connection) => void = () => {}
    const lateConn = { close: mock(() => {}) } as unknown as Connection
    const incoming = {
      accept: async () => ({ connect: () => new Promise<Connection>((r) => (resolveConn = r)) }),
    } as unknown as Incoming
    const release = mock(() => {})

    await expect(handshake(incoming, { release }, 10)).rejects.toThrow(/exceeded 10ms/)
    expect(release).toHaveBeenCalledTimes(1)

    // The handshake settles *after* the deadline -> the orphan must be closed.
    resolveConn(lateConn)
    await flush()
    expect(lateConn.close as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
    expect((lateConn.close as ReturnType<typeof mock>).mock.calls[0][0]).toBe(closeRefused)
    expect((lateConn.close as ReturnType<typeof mock>).mock.calls[0][1]).toEqual(bytesOf('handshake timed out'))
  })
})

describe('handleConnection — the allowlist gate', () => {
  let home: string
  const prevHome = process.env.THUNDERBOLT_HOME
  let stdout: ReturnType<typeof spyOn>
  let stderr: ReturnType<typeof spyOn>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tb-bridge-'))
    process.env.THUNDERBOLT_HOME = home
    stdout = spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(async () => {
    stdout.mockRestore()
    stderr.mockRestore()
    if (prevHome === undefined) delete process.env.THUNDERBOLT_HOME
    else process.env.THUNDERBOLT_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const config: BridgeConfig = {
    protocol: 'acp',
    transport: 'iroh',
    port: 0,
    command: ['__nonexistent_binary_xyzzy__'],
  }

  it('refuses a non-allowlisted peer: closes with closeRefused, never opens a stream or spawns', async () => {
    const acceptBi = mock(async () => ({ recv: {}, send: {} }))
    const connection = {
      remoteId: () => ({ toString: () => 'unknown-peer' }),
      acceptBi,
      close: mock(() => {}),
    } as unknown as Connection
    const incoming = { accept: async () => ({ connect: async () => connection }) } as unknown as Incoming
    const activeProcs = new Set<BridgeProc>()

    await handleConnection(incoming, config, activeProcs, { release: () => {} })

    expect(acceptBi).not.toHaveBeenCalled()
    expect(activeProcs.size).toBe(0)
    const close = connection.close as ReturnType<typeof mock>
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toBe(closeRefused)
    expect(close.mock.calls[0][1]).toEqual(bytesOf('not allowlisted'))
  })

  it('closes an allowlisted-but-idle peer with closeRefused once the accept deadline passes', async () => {
    await add('idle-peer')
    const acceptBi = mock(() => new Promise<never>(() => {})) // client never opens the stream
    const connection = {
      remoteId: () => ({ toString: () => 'idle-peer' }),
      acceptBi,
      close: mock(() => {}),
    } as unknown as Connection
    const incoming = { accept: async () => ({ connect: async () => connection }) } as unknown as Incoming
    const activeProcs = new Set<BridgeProc>()

    await handleConnection(incoming, config, activeProcs, { release: () => {} }, 10)

    expect(acceptBi).toHaveBeenCalledTimes(1)
    expect(activeProcs.size).toBe(0) // nothing spawned for an idle peer
    const close = connection.close as ReturnType<typeof mock>
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toBe(closeRefused)
    expect(close.mock.calls[0][1]).toEqual(bytesOf('idle: no data stream opened'))
  })

  it('closes with a spawn-failure reason when an allowlisted peer opens a stream but the agent cannot spawn', async () => {
    await add('known-peer')
    const closed = mock(() => new Promise<void>(() => {})) // never resolves
    const connection = {
      remoteId: () => ({ toString: () => 'known-peer' }),
      acceptBi: mock(async () => ({ recv: {}, send: {} })),
      closed,
      close: mock(() => {}),
    } as unknown as Connection
    const incoming = { accept: async () => ({ connect: async () => connection }) } as unknown as Incoming
    const activeProcs = new Set<BridgeProc>()

    await handleConnection(incoming, config, activeProcs, { release: () => {} })

    expect(connection.acceptBi as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled() // no proc to bind a kill to
    expect(activeProcs.size).toBe(0)
    const close = connection.close as ReturnType<typeof mock>
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toBe(closeRefused)
    expect(close.mock.calls[0][1]).toEqual(bytesOf("failed to spawn '__nonexistent_binary_xyzzy__'"))
  })

  it('refuses an allowlisted peer at the active-proc cap: closes with "bridge at capacity", no spawn', async () => {
    await add('busy-peer')
    // Fill the registry to the ceiling so the next connection is over-capacity.
    const activeProcs = new Set<BridgeProc>(Array.from({ length: maxActiveProcs }, () => ({}) as BridgeProc))
    const closed = mock(() => new Promise<void>(() => {}))
    const connection = {
      remoteId: () => ({ toString: () => 'busy-peer' }),
      acceptBi: mock(async () => ({ recv: {}, send: {} })),
      closed,
      close: mock(() => {}),
    } as unknown as Connection
    const incoming = { accept: async () => ({ connect: async () => connection }) } as unknown as Incoming

    await handleConnection(incoming, config, activeProcs, { release: () => {} })

    expect(connection.acceptBi as ReturnType<typeof mock>).toHaveBeenCalledTimes(1) // peer opened its stream
    expect(closed).not.toHaveBeenCalled() // nothing spawned, so no kill bound
    expect(activeProcs.size).toBe(maxActiveProcs) // unchanged: refused, not spawned
    const close = connection.close as ReturnType<typeof mock>
    expect(close).toHaveBeenCalledTimes(1)
    expect(close.mock.calls[0][0]).toBe(closeRefused)
    expect(close.mock.calls[0][1]).toEqual(bytesOf('bridge at capacity'))
  })
})

describe('redactArgv — secret redaction in command logs', () => {
  it('redacts the value following --api-key', () => {
    expect(redactArgv(['openai-agent', '--api-key', 'sk-secret', '--model', 'gpt-4'])).toBe(
      'openai-agent --api-key *** --model gpt-4',
    )
  })

  it('redacts the value following --token', () => {
    expect(redactArgv(['agent', '--token', 'bearer-xyz'])).toBe('agent --token ***')
  })

  it('redacts *_KEY env-style assignments while keeping the variable name', () => {
    expect(redactArgv(['OPENAI_API_KEY=sk-abc', 'agent', '--flag'])).toBe('OPENAI_API_KEY=*** agent --flag')
  })

  it('redacts *_TOKEN / *_SECRET / *_PASSWORD env-style assignments, keeping the name', () => {
    expect(redactArgv(['GITHUB_TOKEN=ghp_abc', 'agent'])).toBe('GITHUB_TOKEN=*** agent')
    expect(redactArgv(['DB_SECRET=shh', 'agent'])).toBe('DB_SECRET=*** agent')
    expect(redactArgv(['DB_PASSWORD=hunter2', 'agent'])).toBe('DB_PASSWORD=*** agent')
  })

  it('redacts bare uppercase credential names (PASSWORD=, SECRET=, TOKEN=)', () => {
    expect(redactArgv(['PASSWORD=hunter2'])).toBe('PASSWORD=***')
    expect(redactArgv(['SECRET=shh'])).toBe('SECRET=***')
    expect(redactArgv(['TOKEN=ghp_x'])).toBe('TOKEN=***')
  })

  it('leaves benign argv untouched (no false positives like monkey= or --model=)', () => {
    expect(redactArgv(['claude', 'mcp', 'serve', '--model=gpt-4', 'monkey=foo'])).toBe(
      'claude mcp serve --model=gpt-4 monkey=foo',
    )
  })

  it('does NOT redact a lowercase credential-looking name (case-sensitive)', () => {
    expect(redactArgv(['password=foo', 'token=bar'])).toBe('password=foo token=bar')
  })

  it('handles a secret flag at the very end with no following value', () => {
    expect(redactArgv(['agent', '--api-key'])).toBe('agent --api-key')
  })

  it('redacts the tail of a joined --api-key=value', () => {
    expect(redactArgv(['openai-agent', '--api-key=sk-live-secret', '--model', 'gpt-4'])).toBe(
      'openai-agent --api-key=*** --model gpt-4',
    )
  })

  it('redacts the tail of a joined --token=value', () => {
    expect(redactArgv(['agent', '--token=ghp_secret'])).toBe('agent --token=***')
  })

  it('splits a joined secret on the first = only (hides = inside the value)', () => {
    expect(redactArgv(['agent', '--api-key=abc=def'])).toBe('agent --api-key=***')
  })

  it('redacts a joined secret flag with an empty value', () => {
    expect(redactArgv(['agent', '--api-key='])).toBe('agent --api-key=***')
  })

  it('leaves a non-secret joined flag intact', () => {
    expect(redactArgv(['agent', '--foo=bar'])).toBe('agent --foo=bar')
  })
})

describe('admitConnection — pre-handshake DoS gates', () => {
  let stderr: ReturnType<typeof spyOn>
  beforeEach(() => {
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderr.mockRestore()
  })

  const config: BridgeConfig = { protocol: 'acp', transport: 'iroh', port: 0, command: ['echo'] }

  const fakeIncoming = (): { incoming: Incoming; ignore: ReturnType<typeof mock>; accept: ReturnType<typeof mock> } => {
    const ignore = mock(async () => {})
    const accept = mock(async () => ({ connect: async () => ({}) }))
    const incoming = {
      remoteAddr: async () => ({ kind: 'relay', endpointId: 'peerEID' }),
      ignore,
      accept,
    } as unknown as Incoming
    return { incoming, ignore, accept }
  }

  it('drops a rate-limited connection with ignore() before touching the handshake guard', async () => {
    const { incoming, ignore, accept } = fakeIncoming()
    const tryAcquire = mock(() => true)
    await admitConnection(incoming, config, new Set(), { allow: () => false }, { tryAcquire, release: () => {} })
    expect(ignore).toHaveBeenCalledTimes(1)
    expect(tryAcquire).not.toHaveBeenCalled() // never paid for a handshake slot
    expect(accept).not.toHaveBeenCalled()
  })

  it('drops a connection with ignore() when the handshake guard is at capacity', async () => {
    const { incoming, ignore, accept } = fakeIncoming()
    await admitConnection(
      incoming,
      config,
      new Set(),
      { allow: () => true },
      { tryAcquire: () => false, release: () => {} },
    )
    expect(ignore).toHaveBeenCalledTimes(1)
    expect(accept).not.toHaveBeenCalled() // dropped before the handshake
  })
})
