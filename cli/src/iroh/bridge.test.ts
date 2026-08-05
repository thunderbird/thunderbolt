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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeConfig } from '../agent/types.ts'
import type { AccountAllowlist, FetchFn } from './account-allowlist.ts'
import { maxActiveProcs, redactArgv, type BridgeProc } from '../commands/bridge.ts'
import { add } from './allowlist.ts'
import {
  admitConnection,
  accountTrustBanner,
  closeRefused,
  createHandshakeGuard,
  createRateLimiter,
  handleConnection,
  handshake,
  heartbeatTick,
  heartbeatIntervalMs,
  isConnectionAllowed,
  renderIrohBridgeBanner,
  type OpenConnection,
  remoteKey,
  startAccountTrust,
  startMembershipHeartbeat,
} from './bridge.ts'

/** UTF-8 bytes of a close reason, computed independently of `reasonBytes`. */
const bytesOf = (s: string): number[] => [...Buffer.from(s, 'utf8')]
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('renderIrohBridgeBanner', () => {
  const baseConfig = {
    transport: 'iroh',
    port: 0,
    command: ['local-agent'],
  } as const

  it('directs ACP bridge pairing to the app agents page', () => {
    const banner = renderIrohBridgeBanner(
      { ...baseConfig, protocol: 'acp' },
      'acp-node',
      'acp-ticket',
      false,
      'https://app.example.com/',
    )

    expect(banner).toContain('   pair in Thunderbolt app: https://app.example.com/settings/agents\n')
  })

  it('directs MCP bridge pairing to the app MCP servers page', () => {
    const banner = renderIrohBridgeBanner(
      { ...baseConfig, protocol: 'mcp' },
      'mcp-node',
      'mcp-ticket',
      false,
      'https://app.example.com',
    )

    expect(banner).toContain('   pair in Thunderbolt app: https://app.example.com/settings/mcp-servers\n')
  })
})

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

    await handleConnection(incoming, config, activeProcs, { release: () => {} }, { acceptTimeoutMs: 10 })

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

describe('admitConnection — live session tracking', () => {
  const protocols = ['acp', 'mcp'] as const
  const prevHome = process.env.THUNDERBOLT_HOME
  let home: string
  let stdout: ReturnType<typeof spyOn>
  let stderr: ReturnType<typeof spyOn>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tb-live-session-'))
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

  for (const protocol of protocols) {
    it(`tracks an accepted ${protocol.toUpperCase()} session until heartbeat revocation closes it`, async () => {
      const remoteId = `${protocol}-peer`
      const trusted = new Set([remoteId])
      const accountAllowlist = fakeAllowlist(trusted)
      const openConnections = new Set<OpenConnection>()
      const activeProcs = new Set<BridgeProc>()
      const config: BridgeConfig = {
        protocol,
        transport: 'iroh',
        port: 0,
        command: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
      }
      const closed = Promise.withResolvers<void>()
      const recvRead = Promise.withResolvers<number[]>()
      const read = mock(async () => recvRead.promise)
      const close = mock(() => {
        recvRead.resolve([])
        closed.resolve()
      })
      const connection = {
        remoteId: () => ({ toString: () => remoteId }),
        acceptBi: async () => ({
          recv: { read },
          send: { writeAll: async () => {}, finish: async () => {} },
        }),
        closed: () => closed.promise,
        close,
      } as unknown as Connection
      const incoming = {
        remoteAddr: async () => ({ kind: 'relay', endpointId: remoteId }),
        accept: async () => ({ connect: async () => connection }),
        ignore: async () => {},
      } as unknown as Incoming

      const handling = admitConnection(
        incoming,
        config,
        activeProcs,
        { allow: () => true },
        { tryAcquire: () => true, release: () => {} },
        { accountAllowlist, openConnections },
      )
      try {
        await flush()

        expect([...openConnections]).toEqual([{ remoteId, connection }])

        trusted.clear()
        await heartbeatTick(accountAllowlist, openConnections)
        await handling

        expect(close).toHaveBeenCalledTimes(1)
        expect(openConnections.size).toBe(0)
      } finally {
        recvRead.resolve([])
        closed.resolve()
        await handling
      }
    })
  }
})

/** A stub {@link AccountAllowlist} over a fixed trusted set, with an injectable
 *  refresh and self-revocation flag. Mirrors production: when self-revoked, `has`
 *  trusts nobody so the gate and heartbeat drop every account peer. */
const fakeAllowlist = (
  trusted: Set<string>,
  refresh: () => Promise<void> = async () => {},
  isSelfRevoked: () => boolean = () => false,
): AccountAllowlist => ({
  has: (id) => !isSelfRevoked() && trusted.has(id),
  refresh,
  isSelfRevoked,
})

/** A stub open connection whose `close` is a spy, for heartbeat teardown assertions. */
const fakeOpen = (remoteId: string): { open: OpenConnection; close: ReturnType<typeof mock> } => {
  const close = mock(() => {})
  return { open: { remoteId, connection: { close } as unknown as OpenConnection['connection'] }, close }
}

describe('account trust gate + heartbeat', () => {
  let home: string
  const prevHome = process.env.THUNDERBOLT_HOME
  let stderr: ReturnType<typeof spyOn>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tb-trust-'))
    process.env.THUNDERBOLT_HOME = home
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(async () => {
    stderr.mockRestore()
    if (prevHome === undefined) delete process.env.THUNDERBOLT_HOME
    else process.env.THUNDERBOLT_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  describe('isConnectionAllowed — trust gate (account allowlist OR manual file)', () => {
    it('admits a peer in the account allowlist even when the manual file is empty (auto-trust)', async () => {
      expect(await isConnectionAllowed('acct-peer', fakeAllowlist(new Set(['acct-peer'])))).toBe(true)
    })

    it('admits a peer in the manual file even when it is absent from the account allowlist', async () => {
      await add('manual-peer')
      expect(await isConnectionAllowed('manual-peer', fakeAllowlist(new Set(['someone-else'])))).toBe(true)
    })

    it('denies a peer in neither the account allowlist nor the manual file', async () => {
      await add('other-peer')
      expect(await isConnectionAllowed('stranger', fakeAllowlist(new Set(['acct-peer'])))).toBe(false)
    })

    it('Standalone (no account allowlist): manual file only, admits/denies, never throws', async () => {
      await add('manual-peer')
      expect(await isConnectionAllowed('manual-peer', undefined)).toBe(true)
      expect(await isConnectionAllowed('stranger', undefined)).toBe(false)
    })

    it('self-revoked bridge rejects an account peer at the gate when auto-trust is off', async () => {
      // The allowlist still lists the peer, but this bridge is self-revoked → has() is
      // false → the gate falls through to the (empty) manual file and denies.
      const revoked = fakeAllowlist(
        new Set(['acct-peer']),
        async () => {},
        () => true,
      )
      expect(await isConnectionAllowed('acct-peer', revoked)).toBe(false)
    })

    it('self-revoked bridge still admits a manual-file peer because manual trust persists', async () => {
      await add('manual-peer')
      const revoked = fakeAllowlist(
        new Set(['manual-peer']),
        async () => {},
        () => true,
      )
      expect(await isConnectionAllowed('manual-peer', revoked)).toBe(true)
    })
  })

  describe('heartbeatTick — live-connection revocation', () => {
    it('refreshes the allowlist, tears down a now-revoked peer, and leaves a still-valid one', async () => {
      const refresh = mock(async () => {})
      const allowlist = fakeAllowlist(new Set(['still-valid']), refresh)
      const valid = fakeOpen('still-valid')
      const revoked = fakeOpen('revoked-peer')

      await heartbeatTick(allowlist, new Set([valid.open, revoked.open]))

      expect(refresh).toHaveBeenCalledTimes(1)
      expect(valid.close).not.toHaveBeenCalled()
      expect(revoked.close).toHaveBeenCalledTimes(1)
      expect(revoked.close.mock.calls[0][0]).toBe(closeRefused)
      expect(revoked.close.mock.calls[0][1]).toEqual(bytesOf('membership revoked'))
    })

    it('keeps a peer that survives only in the manual file (account-revoked but manually allowed)', async () => {
      await add('manual-peer')
      const manual = fakeOpen('manual-peer')

      await heartbeatTick(fakeAllowlist(new Set()), new Set([manual.open]))

      expect(manual.close).not.toHaveBeenCalled()
    })

    it('self-revoked bridge tears down all account-auto-trusted sessions and logs once', async () => {
      const refresh = mock(async () => {})
      // Non-empty account set, but this bridge is self-revoked → has() trusts nobody,
      // so every same-account session is torn down within the interval.
      const allowlist = fakeAllowlist(new Set(['acct-a', 'acct-b']), refresh, () => true)
      const a = fakeOpen('acct-a')
      const b = fakeOpen('acct-b')

      await heartbeatTick(allowlist, new Set([a.open, b.open]))

      expect(refresh).toHaveBeenCalledTimes(1)
      expect(a.close).toHaveBeenCalledTimes(1)
      expect(b.close).toHaveBeenCalledTimes(1)
      const logged = stderr.mock.calls
        .flat()
        .some((s: unknown) => String(s).includes('no longer in the account allowlist'))
      expect(logged).toBe(true)
    })

    it('self-revoked bridge preserves a manual-file peer during teardown', async () => {
      await add('manual-peer')
      const allowlist = fakeAllowlist(
        new Set(['manual-peer']),
        async () => {},
        () => true,
      )
      const manual = fakeOpen('manual-peer')

      await heartbeatTick(allowlist, new Set([manual.open]))

      expect(manual.close).not.toHaveBeenCalled()
    })

    it('isolates a connection whose close() throws — the sweep continues to other peers', async () => {
      const throwingClose = mock(() => {
        throw new Error('NAPI close failed')
      })
      const bad: OpenConnection = {
        remoteId: 'bad-peer',
        connection: { close: throwingClose } as unknown as OpenConnection['connection'],
      }
      const good = fakeOpen('good-peer')

      // Empty account set + empty manual file → both peers are revoked and get closed.
      await heartbeatTick(fakeAllowlist(new Set()), new Set([bad, good.open]))

      expect(throwingClose).toHaveBeenCalledTimes(1) // attempted despite throwing
      expect(good.close).toHaveBeenCalledTimes(1) // sweep survived the throw and continued
    })
  })
})

describe('startMembershipHeartbeat — 45s cadence', () => {
  it('runs on a 45s interval', () => {
    expect(heartbeatIntervalMs).toBe(45_000)
  })

  it('refreshes each interval until stopped, driven by the injected clock (no real timers)', async () => {
    const refresh = mock(async () => {})
    const allowlist = fakeAllowlist(new Set(), refresh)
    const pending: Array<() => void> = []
    const sleep = mock((_ms: number) => new Promise<void>((resolve) => pending.push(resolve)))
    const releaseOne = (): void => pending.shift()?.()

    const stop = startMembershipHeartbeat(allowlist, new Set(), { now: () => 0, sleep })

    await flush() // loop reaches the first sleep
    expect(sleep).toHaveBeenCalledWith(heartbeatIntervalMs)

    releaseOne() // first 45s elapses
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)

    releaseOne() // second 45s elapses
    await flush()
    expect(refresh).toHaveBeenCalledTimes(2)

    stop()
    releaseOne() // wake the loop so it observes running=false and exits
    await flush()
    expect(refresh).toHaveBeenCalledTimes(2) // no tick after stop
  })
})

describe('startAccountTrust — degradation boundary', () => {
  const prevHome = process.env.THUNDERBOLT_HOME
  const prevToken = process.env.THUNDERBOLT_TOKEN
  let home: string
  let stderr: ReturnType<typeof spyOn>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tb-account-trust-'))
    process.env.THUNDERBOLT_HOME = home
    delete process.env.THUNDERBOLT_TOKEN
    stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    stderr.mockRestore()
    if (prevHome === undefined) delete process.env.THUNDERBOLT_HOME
    else process.env.THUNDERBOLT_HOME = prevHome
    if (prevToken === undefined) delete process.env.THUNDERBOLT_TOKEN
    else process.env.THUNDERBOLT_TOKEN = prevToken
    await rm(home, { recursive: true, force: true })
  })

  it('disables account auto-trust when stored auth JSON is corrupt', async () => {
    await writeFile(join(home, 'auth.json'), '{"token":')

    await expect(startAccountTrust(new Set(), 'self-node')).resolves.toBeUndefined()

    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0][0])).toContain('account auto-trust disabled:')
    expect(String(stderr.mock.calls[0][0])).toContain('using manual allowlist only')
  })

  it('reports revoked registration, disables auto-trust, and keeps the manual allowlist active', async () => {
    await writeFile(join(home, 'auth.json'), JSON.stringify({ token: 'session-token', cloudUrl: 'https://api.test/v1' }))
    await add('manual-peer')
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ error: 'Bridge device revoked' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })

    const accountTrust = await startAccountTrust(new Set(), 'self-node', fetchFn)

    expect(accountTrust).toBeUndefined()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0][0])).toBe(
      '⚡ iroh bridge: this device was revoked on your account — remove it in Settings → Devices to pair again (manual allowlist still works)\n',
    )
    expect(accountTrustBanner(accountTrust !== undefined)).toBe(
      '   same-account auto-trust: off (manual allowlist only)\n' +
        '   allow a peer with: thunderbolt iroh allow <their-node-id>\n',
    )
    expect(await isConnectionAllowed('manual-peer', accountTrust?.accountAllowlist)).toBe(true)
  })
})
