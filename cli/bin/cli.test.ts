// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { test, expect, mock } from 'bun:test'
import { run } from './cli'
import { UnavailableError } from '../src/errors'
import type {
  BridgeOptions,
  GenerateBearer,
  MakeLogger,
  McpFaceOptions,
  StartBridge,
  StartMcpFace,
  StartTunnel,
} from '../src/types'

/** A captured process-event listener (mirrors the CLI's injectable `on`). */
type SignalListener = (...args: unknown[]) => unknown

/** The injectable collaborators `run` forwards to the bridge subcommand. */
type HarnessDeps = {
  startBridge?: StartBridge
  startMcpFace?: StartMcpFace
  startTunnel?: StartTunnel
  generateBearer?: GenerateBearer
  makeLogger?: MakeLogger
  on?: (event: string, listener: SignalListener) => void
  removeListener?: (event: string, listener: SignalListener) => void
}

/** A fake stdout/stderr stream the test can read back (`text()`). */
type Sink = NodeJS.WritableStream & { text: () => string }

/** Collects writes to a fake stream. */
const makeSink = (): Sink => {
  const chunks: string[] = []
  return { write: (s: string) => chunks.push(s), text: () => chunks.join('') } as unknown as Sink
}

/** Build a default deps bundle with spies the test can inspect/override. */
const makeHarness = (over: { deps?: HarnessDeps } = {}) => {
  const signals: Record<string, SignalListener> = {}
  const face = { url: 'ws://127.0.0.1:5000', close: mock(async () => {}), kill: mock(() => {}) }
  const mcpFace = { url: 'http://127.0.0.1:54321/mcp', close: mock(async () => {}), kill: mock(() => {}) }
  const tunnel = { publicUrl: 'https://x.trycloudflare.com', bearer: 'secret', close: mock(async () => {}) }
  const startBridge = mock<StartBridge>(async () => face)
  const startMcpFace = mock<StartMcpFace>(async () => mcpFace)
  const startTunnel = mock(async () => tunnel)
  const generateBearer = mock(() => 'minted-bearer')
  const logger = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), banner: mock(() => {}) }
  const makeLogger = mock<MakeLogger>(() => logger)
  const exit = mock(() => {})
  const stdout = makeSink()
  const stderr = makeSink()
  const deps: HarnessDeps = {
    startBridge,
    startMcpFace,
    startTunnel,
    generateBearer,
    makeLogger,
    on: (sig: string, fn: SignalListener) => {
      signals[sig] = fn
    },
    removeListener: () => {},
    ...over.deps,
  }
  return {
    face,
    mcpFace,
    tunnel,
    startBridge,
    startMcpFace,
    startTunnel,
    generateBearer,
    logger,
    makeLogger,
    exit,
    stdout,
    stderr,
    signals,
    deps,
  }
}

test('root --help prints root usage (lists the bridge command) to stdout and exits 0 (no child spawned)', async () => {
  const h = makeHarness()
  await run({ argv: ['--help'], stdout: h.stdout, stderr: h.stderr, exit: h.exit, deps: h.deps })
  expect(h.stdout.text()).toContain('Usage:')
  expect(h.stdout.text()).toContain('thunderbolt <command>')
  expect(h.stdout.text()).toContain('bridge')
  expect(h.exit).toHaveBeenCalledWith(0)
  expect(h.startBridge).not.toHaveBeenCalled()
})

test('no args prints root usage and exits 0', async () => {
  const h = makeHarness()
  await run({ argv: [], stdout: h.stdout, stderr: h.stderr, exit: h.exit, deps: h.deps })
  expect(h.stdout.text()).toContain('thunderbolt <command>')
  expect(h.exit).toHaveBeenCalledWith(0)
  expect(h.startBridge).not.toHaveBeenCalled()
})

test('bridge --help prints the bridge usage to stdout and exits 0 (no child spawned)', async () => {
  const h = makeHarness()
  await run({ argv: ['bridge', '--help'], stdout: h.stdout, stderr: h.stderr, exit: h.exit, deps: h.deps })
  expect(h.stdout.text()).toContain('thunderbolt bridge --mode <acp|mcp>')
  expect(h.exit).toHaveBeenCalledWith(0)
  expect(h.startBridge).not.toHaveBeenCalled()
})

test('--version prints the version and exits 0', async () => {
  const h = makeHarness()
  await run({ argv: ['--version'], stdout: h.stdout, stderr: h.stderr, exit: h.exit, deps: h.deps })
  expect(h.stdout.text().trim().length).toBeGreaterThan(0)
  expect(h.exit).toHaveBeenCalledWith(0)
})

test('an unknown command -> stderr usage message, exit 64, no spawn', async () => {
  const h = makeHarness()
  await run({ argv: ['bogus'], stdout: h.stdout, stderr: h.stderr, exit: h.exit, deps: h.deps })
  expect(h.exit).toHaveBeenCalledWith(64)
  expect(h.stderr.text()).toContain('unknown command')
  expect(h.startBridge).not.toHaveBeenCalled()
})

test('bridge with missing --mode -> stderr usage message, exit 64, no spawn', async () => {
  const h = makeHarness()
  await run({ argv: ['bridge', '--', 'node', 'a.js'], stdout: h.stdout, stderr: h.stderr, exit: h.exit, deps: h.deps })
  expect(h.exit).toHaveBeenCalledWith(64)
  expect(h.stderr.text().length).toBeGreaterThan(0)
  expect(h.startBridge).not.toHaveBeenCalled()
})

test('bridge --mode acp -- <cmd> dispatches to startBridge with parsed launch + options', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'acp', '--allow-origin', 'http://a', '--', 'node', 'agent.js'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.startBridge).toHaveBeenCalledTimes(1)
  const arg = h.startBridge.mock.calls[0][0]
  expect(arg.launch).toEqual(['node', 'agent.js'])
  expect(arg.host).toBe('127.0.0.1')
  expect(arg.allowOrigins).toEqual(['http://a'])
})

test('--mode mcp --tunnel: face binds BEFORE the tunnel, which targets the face url with the same minted bearer', async () => {
  const h = makeHarness()
  const order: string[] = []
  const startMcpFace = mock<StartMcpFace>(async () => {
    order.push('face')
    return h.mcpFace
  })
  const startTunnel = mock<StartTunnel>(async () => {
    order.push('tunnel')
    return h.tunnel
  })
  h.deps.startMcpFace = startMcpFace
  h.deps.startTunnel = startTunnel
  await run({
    argv: ['bridge', '--mode', 'mcp', '--tunnel', '--', 'srv'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(startMcpFace).toHaveBeenCalledTimes(1)
  expect(startTunnel).toHaveBeenCalledTimes(1)
  // The face must bind before the tunnel so the tunnel targets a REAL bound url.
  expect(order).toEqual(['face', 'tunnel'])
  // The tunnel points at the face's resolved url — never a pre-bind port-0 placeholder.
  expect(startTunnel.mock.calls[0][0].localUrl).toBe(h.mcpFace.url)
  // One bearer is minted and threaded into BOTH the face and the tunnel.
  expect(h.generateBearer).toHaveBeenCalledTimes(1)
  expect(startMcpFace.mock.calls[0][0].bearer).toBe('minted-bearer')
  expect(startTunnel.mock.calls[0][0].bearer).toBe('minted-bearer')
})

test('--mode mcp without --tunnel does not start a tunnel and bearer is undefined', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'mcp', '--', 'srv'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.startTunnel).not.toHaveBeenCalled()
  expect(h.startMcpFace.mock.calls[0][0].bearer).toBeUndefined()
})

test('SIGINT handler SIGKILLs (via face close) the live child then exits 130', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await h.signals.SIGINT()
  expect(h.face.close).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenLastCalledWith(130)
})

test('SIGTERM handler closes the face then exits 0', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await h.signals.SIGTERM()
  expect(h.face.close).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenLastCalledWith(0)
})

test('SIGINT during shutdown: the child dying from the graceful stop must not override exit 130', async () => {
  const h = makeHarness()
  let captured: BridgeOptions | undefined
  // Model the real face: stopping it (face.close) SIGTERMs the child, whose exit fires
  // onChildExit with signal 'SIGTERM' (childExitToCode -> 70). That deliberate-stop child
  // death must NOT beat the signal handler's intended 130 — exactly one exit, code 130.
  const startBridge = mock(async (args: BridgeOptions) => {
    captured = args
    h.face.close = mock(async () => {
      await captured!.onChildExit!({ code: null, signal: 'SIGTERM' })
    })
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await h.signals.SIGINT()
  expect(h.exit).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenCalledWith(130)
})

test('SIGTERM during shutdown: the child dying from the graceful stop must not override exit 0', async () => {
  const h = makeHarness()
  let captured: BridgeOptions | undefined
  const startBridge = mock(async (args: BridgeOptions) => {
    captured = args
    h.face.close = mock(async () => {
      await captured!.onChildExit!({ code: null, signal: 'SIGTERM' })
    })
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await h.signals.SIGTERM()
  expect(h.exit).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenCalledWith(0)
})

test('a startup teardown (tunnel failure) keeps its own exit code (69); the reaped child does not override it', async () => {
  const h = makeHarness()
  let captured: McpFaceOptions | undefined
  // The MCP face bound (child live), then the tunnel start throws. The catch reaps the
  // face, SIGTERMing the child -> onChildExit(70). The startup error's code (69) must win.
  const startMcpFace = mock(async (args: McpFaceOptions) => {
    captured = args
    h.mcpFace.close = mock(async () => {
      await captured!.onChildExit!({ code: null, signal: 'SIGTERM' })
    })
    return h.mcpFace
  })
  const startTunnel = mock(async () => {
    throw new UnavailableError({ code: 'ECONNREFUSED' })
  })
  h.deps.startMcpFace = startMcpFace
  h.deps.startTunnel = startTunnel
  await run({
    argv: ['bridge', '--mode', 'mcp', '--tunnel', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.exit).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenCalledWith(69)
})

test('a fatal error during a wedged shutdown still forces SIGKILL + exit 70 (never-orphan backstop stays authoritative)', async () => {
  const h = makeHarness()
  // The graceful stop wedges: face.close never resolves, so the signal teardown is
  // stuck mid-reap with the exit unclaimed-by-completion. A truly uncaught error must
  // still force the child down and exit 70 — onFatal does NOT yield to the in-progress
  // shutdown (unlike onChildExit, which must).
  h.face.close = mock(() => new Promise<void>(() => {}))
  const startBridge = mock(async () => h.face)
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  void h.signals.SIGINT() // claims `exiting`, then hangs in reap (face.close never resolves)
  await Promise.resolve()
  h.signals.uncaughtException(new Error('boom'))
  expect(h.face.kill).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenCalledWith(70)
})

test('a bind failure from the face (UnavailableError EADDRINUSE) maps to exit 69 and reaps', async () => {
  const err = Object.assign(new Error('addr'), { name: 'UnavailableError', code: 'EADDRINUSE' })
  const startBridge = mock(async () => {
    throw err
  })
  const h = makeHarness({ deps: { startBridge } })
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.exit).toHaveBeenLastCalledWith(69)
})

test('an unexpected internal throw maps to exit 70', async () => {
  const startBridge = mock(async () => {
    throw new Error('boom')
  })
  const h = makeHarness({ deps: { startBridge } })
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.exit).toHaveBeenLastCalledWith(70)
})

test('logger is constructed with json/verbose flags and the injected stderr sink', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'acp', '--json', '--verbose', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.makeLogger).toHaveBeenCalledTimes(1)
  const opts = h.makeLogger.mock.calls[0][0]
  expect(opts.json).toBe(true)
  expect(opts.verbose).toBe(true)
  expect(opts.sink).toBe(h.stderr)
})

test('insecureFlagWarnings are emitted to stderr (via logger.warn) before the face starts', async () => {
  const h = makeHarness()
  let warnedBeforeStart = false
  const startBridge = mock(async () => {
    warnedBeforeStart = h.logger.warn.mock.calls.length > 0
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--allow-any-origin', '--host', '0.0.0.0', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(warnedBeforeStart).toBe(true)
})

test('on clean child exit the bridge exits with the child-derived code (0)', async () => {
  const h = makeHarness()
  let captured: BridgeOptions | undefined
  const startBridge = mock(async (args: BridgeOptions) => {
    captured = args
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await captured!.onChildExit!({ code: 0, signal: null })
  expect(h.exit).toHaveBeenLastCalledWith(0)
})

test('a nonzero child exit derives exit 70', async () => {
  const h = makeHarness()
  let captured: BridgeOptions | undefined
  const startBridge = mock(async (args: BridgeOptions) => {
    captured = args
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await captured!.onChildExit!({ code: 1, signal: null })
  expect(h.exit).toHaveBeenLastCalledWith(70)
})

test('a natural child exit on a signal (signal:SIGTERM, the bridge got no OS signal) derives exit 70', async () => {
  const h = makeHarness()
  let captured: BridgeOptions | undefined
  const startBridge = mock(async (args: BridgeOptions) => {
    captured = args
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await captured!.onChildExit!({ code: null, signal: 'SIGTERM' })
  expect(h.exit).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenCalledWith(70)
})

test('a natural child exit then a SIGINT exits exactly once with the child-derived code (no double exit)', async () => {
  const h = makeHarness()
  let captured: BridgeOptions | undefined
  const startBridge = mock(async (args: BridgeOptions) => {
    captured = args
    return h.face
  })
  h.deps.startBridge = startBridge
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  await captured!.onChildExit!({ code: 0, signal: null })
  // A signal arriving after the child already claimed the exit must be a no-op.
  await h.signals.SIGINT()
  expect(h.exit).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenCalledWith(0)
})

test('uncaughtException SIGKILLs the live child (face.kill) and exits 70 (never-orphan)', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  h.signals.uncaughtException(Object.assign(new Error('boom'), { code: 'ERR_FOO' }))
  expect(h.face.kill).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenLastCalledWith(70)
})

test('unhandledRejection SIGKILLs the live child (face.kill) and exits 70 (never-orphan)', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  h.signals.unhandledRejection(new Error('rejected'))
  expect(h.face.kill).toHaveBeenCalledTimes(1)
  expect(h.exit).toHaveBeenLastCalledWith(70)
})

test('bridge --tunnel without --mode mcp is a usage error (exit 64)', async () => {
  const h = makeHarness()
  await run({
    argv: ['bridge', '--tunnel', '--mode', 'acp', '--', 'x'],
    stdout: h.stdout,
    stderr: h.stderr,
    exit: h.exit,
    deps: h.deps,
  })
  expect(h.exit).toHaveBeenCalledWith(64)
  expect(h.startBridge).not.toHaveBeenCalled()
})
