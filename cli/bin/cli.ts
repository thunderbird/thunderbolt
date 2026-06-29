#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Composition root. Thin wiring only: parse argv, short-circuit error/help/
// version, then dispatch to the resolved subcommand. The `bridge` command builds
// the logger, installs signal handlers, starts the ACP or MCP face, and
// translates every outcome into a sysexits exit code. Every external collaborator
// is injectable via a single `deps` object so the whole root is testable with no
// real sockets.

import { parseArgs } from '../src/args'
import { EX, toExitCode, toMessage, childExitToCode, UnavailableError } from '../src/errors'
import { makeLogger } from '../src/log'
import { insecureFlagWarnings } from '../src/util'
import { startBridge } from '../src/server'
import { startMcpFace } from '../src/mcp-server'
import { startTunnel, generateBearer } from '../src/tunnel'
import type {
  ChildExit,
  FaceHandle,
  GenerateBearer,
  MakeLogger,
  ParseArgsResult,
  ParsedArgs,
  StartBridge,
  StartMcpFace,
  StartTunnel,
  TunnelHandle,
} from '../src/types'

// esbuild injects this global via `define` at build time; declare it so tsc sees
// it. Undefined when the bin runs un-bundled straight from source.
declare const __BRIDGE_VERSION__: string | undefined

// esbuild inlines this; a fallback keeps the un-bundled bin runnable from source.
const BRIDGE_VERSION = typeof __BRIDGE_VERSION__ !== 'undefined' ? __BRIDGE_VERSION__ : '0.0.0-dev'

/** A process-event listener captured for one-shot, never-orphan teardown wiring. */
type SignalListener = (...args: unknown[]) => unknown

/** Injectable collaborators forwarded from `run` to the resolved subcommand. */
type RunDeps = {
  startBridge?: StartBridge
  startMcpFace?: StartMcpFace
  startTunnel?: StartTunnel
  generateBearer?: GenerateBearer
  makeLogger?: MakeLogger
  on?: (event: string, listener: SignalListener) => void
  removeListener?: (event: string, listener: SignalListener) => void
}

/** Options for `run`. Every sink/collaborator is injectable so tests use no real sockets. */
type RunOptions = {
  argv?: string[]
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  exit?: (code: number) => void
  deps?: RunDeps
}

/** The io bundle `runBridge` writes diagnostics + exits through. */
type RunBridgeIo = {
  stderr: NodeJS.WritableStream
  exit: (code: number) => void
  deps: RunDeps
}

const ROOT_HELP_TEXT = `thunderbolt — Thunderbolt's local stdio bridge toolkit.

Usage:
  thunderbolt <command> [options]

Commands:
  bridge   bridge a local stdio ACP/MCP server to a loopback face

Run \`thunderbolt bridge --help\` for the bridge options.

  -h, --help      print this help and exit
  -V, --version   print the version and exit`

const BRIDGE_HELP_TEXT = `thunderbolt bridge — bridge a local stdio ACP/MCP server to a loopback face.

Usage:
  thunderbolt bridge --mode <acp|mcp> [options] -- <launch>...

Everything after \`--\` is the child launch argv, passed verbatim to spawn.

Options:
  --mode <acp|mcp>     required; acp => WebSocket face, mcp => Streamable HTTP face
  --host <host>        bind host (default 127.0.0.1)
  --port <n>           bind port (default 0 = OS-assigned)
  --allow-origin <o>   add an allowed Origin (repeatable)
  --allow-any-origin   disable the Origin gate (insecure; warns)
  --tunnel             expose the MCP face via a cloudflared quick tunnel (mcp only)
  --json               machine-readable diagnostics, one JSON object per line
  --verbose            extra diagnostic detail
  -h, --help           print this help and exit
  -V, --version        print the version and exit`

/** Usage text keyed by the parser's `help` intent (`'root'` | the command name). */
const HELP: Record<'root' | 'bridge', string> = { root: ROOT_HELP_TEXT, bridge: BRIDGE_HELP_TEXT }

/**
 * PII-safe error code for the uncaught-error backstop log. Mirrors the original
 * `err && err.code` truthiness: a truthy `code` is emitted verbatim, otherwise
 * the fixed `'INTERNAL'` token (never the message/stack of an arbitrary error).
 */
const fatalCode = (err: unknown): string | number | boolean => {
  const code = (err as { code?: string | number | boolean } | null | undefined)?.code
  return err && code ? code : 'INTERNAL'
}

/**
 * Run the `bridge` subcommand: build the logger, warn on insecure flags, wire the
 * never-orphan lifecycle (signal handlers + an uncaught-error backstop), and start
 * the ACP or MCP face. Returns once the outcome is decided; the process is kept
 * alive by the open server/sockets until a signal or child exit closes the face.
 */
const runBridge = async (parsed: ParsedArgs, { stderr, exit, deps }: RunBridgeIo): Promise<void> => {
  const _startBridge = deps.startBridge ?? startBridge
  const _startMcpFace = deps.startMcpFace ?? startMcpFace
  const _startTunnel = deps.startTunnel ?? startTunnel
  const _generateBearer = deps.generateBearer ?? generateBearer
  const _makeLogger = deps.makeLogger ?? makeLogger
  const onSignal =
    deps.on ??
    ((event: string, listener: SignalListener): void => {
      process.on(event, listener)
    })
  const offSignal =
    deps.removeListener ??
    ((event: string, listener: SignalListener): void => {
      process.removeListener(event, listener)
    })

  const logger = _makeLogger({ json: parsed.json, verbose: parsed.verbose, sink: stderr })

  // Emit insecure-flag warnings before binding anything.
  for (const line of insecureFlagWarnings({
    host: parsed.host,
    allowAnyOrigin: parsed.allowAnyOrigin,
    tunnel: parsed.tunnel,
  })) {
    logger.warn('insecure-flag', { code: line })
  }

  // Shared teardown state so every fatal path can SIGKILL a live child first.
  const live: { face: FaceHandle | null; tunnel: TunnelHandle | null } = { face: null, tunnel: null }

  const reap = async (): Promise<void> => {
    // never-orphan: stop the face (which stops the child) and the tunnel.
    if (live.face) await live.face.close().catch(() => {})
    if (live.tunnel) await live.tunnel.close().catch(() => {})
  }

  // Exactly one path decides the exit code. A signal/fatal/startup teardown stops the
  // child itself (face.close -> SIGTERM, or face.kill -> SIGKILL), so the child exit it
  // triggers must not override the intended code: whichever path runs first claims the
  // exit and the others become no-ops. Set synchronously before any `await`, so the
  // child's exit (a later event-loop turn) always sees the claim.
  let exiting = false

  // The child exiting on its own drives the bridge's own exit code — unless a signal,
  // fatal, or startup teardown already claimed it (then the child death is a consequence
  // of our deliberate stop and must not override the intended code).
  const onChildExit = async (info: ChildExit): Promise<void> => {
    if (exiting) return
    exiting = true
    offSignal('SIGINT', sigintHandler)
    offSignal('SIGTERM', sigtermHandler)
    if (live.tunnel) await live.tunnel.close().catch(() => {})
    exit(childExitToCode(info))
  }

  // One-shot signal handlers -> graceful stop -> derived exit code.
  const handleSignal = (signal: NodeJS.Signals) => async (): Promise<void> => {
    if (exiting) return
    exiting = true
    offSignal('SIGINT', sigintHandler)
    offSignal('SIGTERM', sigtermHandler)
    await reap()
    exit(signal === 'SIGINT' ? EX.SIGINT : EX.OK)
  }
  const sigintHandler = handleSignal('SIGINT')
  const sigtermHandler = handleSignal('SIGTERM')
  onSignal('SIGINT', sigintHandler)
  onSignal('SIGTERM', sigtermHandler)

  // Never-orphan backstop for truly uncaught errors: SIGKILL the child
  // synchronously (no async grace — the process is about to die) then exit 70.
  const onFatal = (err: unknown): void => {
    // The never-orphan backstop for truly uncaught errors stays authoritative: it must
    // force the child down and exit even if a graceful teardown is already in progress
    // (and might be wedged), so it does NOT yield to `exiting`. It still CLAIMS it, so a
    // child reaped by its SIGKILL can't override EX.SOFTWARE via onChildExit.
    exiting = true
    offSignal('SIGINT', sigintHandler)
    offSignal('SIGTERM', sigtermHandler)
    if (live.face) live.face.kill() // immediate SIGKILL — never-orphan backstop
    if (live.tunnel) live.tunnel.close().catch(() => {}) // best-effort
    logger.error('uncaught', { code: fatalCode(err) })
    exit(EX.SOFTWARE)
  }
  onSignal('uncaughtException', onFatal)
  onSignal('unhandledRejection', onFatal)

  try {
    if (parsed.mode === 'acp') {
      const face = await _startBridge({
        launch: parsed.launch,
        host: parsed.host,
        port: parsed.port,
        allowOrigins: parsed.allowOrigins,
        allowAnyOrigin: parsed.allowAnyOrigin,
        logger,
        onChildExit,
      })
      live.face = face
      // ACP face resolves on child exit via its own close(); cli derives the code
      // from the child exit propagated by server.ts.
      return
    }

    // mode === 'mcp'. Mint the bearer first, bind the face, THEN tunnel to the
    // face's REAL bound URL — never a pre-bind port-0 placeholder. The same
    // bearer fronts both the local face and the public tunnel.
    const bearer = parsed.tunnel ? _generateBearer() : undefined
    const face = await _startMcpFace({
      launch: parsed.launch,
      host: parsed.host,
      port: parsed.port,
      bearer,
      allowOrigins: parsed.allowOrigins,
      allowAnyOrigin: parsed.allowAnyOrigin,
      logger,
      onChildExit,
    })
    live.face = face

    if (parsed.tunnel) {
      // If the tunnel fails here the catch path reaps live.face — never-orphan.
      // bearer is non-null here: it was minted above under the same `parsed.tunnel`.
      live.tunnel = await _startTunnel({ localUrl: face.url, bearer: bearer!, logger })
    }
    return
  } catch (err) {
    if (exiting) return // a signal/child teardown already claimed the exit code
    exiting = true
    await reap() // never-orphan before exiting on any fatal path
    logger.error('fatal', { code: err instanceof UnavailableError ? err.code : 'INTERNAL' })
    stderr.write(`${toMessage(err)}\n`)
    return exit(toExitCode(err))
  }
}

/**
 * CLI composition root. Parse argv, short-circuit error/help/version, then
 * dispatch to the resolved subcommand. All exits go through the injected `exit`
 * so tests assert the code without terminating.
 */
const run = async ({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  exit = process.exit,
  deps = {},
}: RunOptions = {}): Promise<void> => {
  const parsed: ParseArgsResult | { error: unknown } = (() => {
    try {
      return parseArgs(argv)
    } catch (err) {
      return { error: err }
    }
  })()

  if ('error' in parsed) {
    stderr.write(`${toMessage(parsed.error)}\n`)
    return exit(toExitCode(parsed.error))
  }
  if ('help' in parsed) {
    stdout.write(`${HELP[parsed.help]}\n`)
    return exit(EX.OK)
  }
  if ('version' in parsed) {
    stdout.write(`${BRIDGE_VERSION}\n`)
    return exit(EX.OK)
  }

  // Dispatch the resolved subcommand. The parser rejects unknown commands, so
  // `parsed.command` is always a known case here; a future `thunderbolt <next>` is
  // a new `case` + a `run<Next>` — the bridge path stays untouched.
  switch (parsed.command) {
    case 'bridge':
      return runBridge(parsed, { stderr, exit, deps })
    default:
      // Unreachable today (the parser only resolves known commands), but guards a
      // future `thunderbolt <next>` wired into the parser yet not here from silently
      // hanging — run() returning without ever calling exit().
      throw new Error(`unhandled command: ${parsed.command}`)
  }
}

export { run }

// Module side-effect entry: run when invoked as the program (not when required
// by a test). Bundled or executed directly, this is the program entrypoint.
// `require`/`module` are CJS globals esbuild preserves in the bundled CJS entry;
// @types/node declares both as ambient globals so the source still type-checks.
if (require.main === module) {
  run().catch((err: unknown) => {
    process.stderr.write(`${toMessage(err)}\n`)
    process.exit(toExitCode(err))
  })
}
