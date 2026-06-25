#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Composition root. Thin wiring only: parse argv, build the logger, validate,
// then dispatch to the ACP or MCP face, install signal handlers, and translate
// every outcome into a sysexits exit code. Every external collaborator is
// injectable via a single `deps` object so the whole root is testable with no
// real sockets.

'use strict'

const { parseArgs } = require('../src/args')
const { EX, toExitCode, toMessage, childExitToCode, UnavailableError } = require('../src/errors')
const { makeLogger } = require('../src/log')
const { insecureFlagWarnings } = require('../src/util')
const { startBridge } = require('../src/server')
const { startMcpFace } = require('../src/mcp-server')
const { startTunnel } = require('../src/tunnel')

// esbuild inlines this; a fallback keeps the un-bundled bin runnable from source.
const BRIDGE_VERSION = typeof __BRIDGE_VERSION__ !== 'undefined' ? __BRIDGE_VERSION__ : '0.0.0-dev'

const HELP_TEXT = `thunderbolt-stdio-bridge — bridge a local stdio ACP/MCP server to a loopback face.

Usage:
  thunderbolt-stdio-bridge --mode <acp|mcp> [options] -- <launch>...

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

/**
 * Run the bridge CLI. Returns once the process outcome is decided; all exits go
 * through the injected `exit` so tests assert the code without terminating.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.argv] - argv without node/script (process.argv.slice(2)).
 * @param {NodeJS.WritableStream} [opts.stdout] - help/version sink only.
 * @param {NodeJS.WritableStream} [opts.stderr] - all diagnostics + banner.
 * @param {(code: number) => void} [opts.exit]
 * @param {Object} [opts.deps] - injectable { startBridge, startMcpFace, startTunnel, makeLogger, on, removeListener }.
 * @returns {Promise<void>}
 */
const run = async ({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  exit = process.exit,
  deps = {},
} = {}) => {
  const _startBridge = deps.startBridge ?? startBridge
  const _startMcpFace = deps.startMcpFace ?? startMcpFace
  const _startTunnel = deps.startTunnel ?? startTunnel
  const _makeLogger = deps.makeLogger ?? makeLogger
  const onSignal = deps.on ?? process.on.bind(process)
  const offSignal = deps.removeListener ?? process.removeListener.bind(process)

  // 1) Parse argv. Help/version short-circuit to stdout (no child, no framing).
  const parsed = (() => {
    try {
      return parseArgs(argv)
    } catch (err) {
      return { error: err }
    }
  })()

  if (parsed.error) {
    stderr.write(`${toMessage(parsed.error)}\n`)
    return exit(toExitCode(parsed.error))
  }
  if (parsed.help) {
    stdout.write(`${HELP_TEXT}\n`)
    return exit(EX.OK)
  }
  if (parsed.version) {
    stdout.write(`${BRIDGE_VERSION}\n`)
    return exit(EX.OK)
  }

  const logger = _makeLogger({ json: parsed.json, verbose: parsed.verbose, sink: stderr })

  // 3) Emit insecure-flag warnings before binding anything.
  for (const line of insecureFlagWarnings({
    host: parsed.host,
    allowAnyOrigin: parsed.allowAnyOrigin,
    tunnel: parsed.tunnel,
  })) {
    logger.warn('insecure-flag', { code: line })
  }

  // Shared teardown state so every fatal path can SIGKILL a live child first.
  const live = { face: null, tunnel: null }

  const reap = async () => {
    // never-orphan: stop the face (which stops the child) and the tunnel.
    if (live.face) await live.face.close().catch(() => {})
    if (live.tunnel) await live.tunnel.close().catch(() => {})
  }

  // The child exiting on its own drives the bridge's own exit code.
  const onChildExit = async (info) => {
    offSignal('SIGINT', sigintHandler)
    offSignal('SIGTERM', sigtermHandler)
    if (live.tunnel) await live.tunnel.close().catch(() => {})
    exit(childExitToCode(info))
  }

  // 6) One-shot signal handlers -> graceful stop -> derived exit code.
  const handleSignal = (signal) => async () => {
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
  const onFatal = (err) => {
    offSignal('SIGINT', sigintHandler)
    offSignal('SIGTERM', sigtermHandler)
    if (live.face) live.face.kill() // immediate SIGKILL — never-orphan backstop
    if (live.tunnel) live.tunnel.close().catch(() => {}) // best-effort
    logger.error('uncaught', { code: err && err.code ? err.code : 'INTERNAL' })
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
      // from the child exit propagated by server.js. The face stays alive until a
      // signal or child exit closes it; run() returns and the process is kept
      // alive by the open server/sockets.
      return
    }

    // mode === 'mcp'
    const bearerSource = parsed.tunnel
      ? await (async () => {
          const tunnel = await _startTunnel({
            localUrl: `http://127.0.0.1:${parsed.port}/mcp`,
            logger,
          })
          live.tunnel = tunnel
          return tunnel.bearer
        })()
      : undefined

    const face = await _startMcpFace({
      launch: parsed.launch,
      host: parsed.host,
      port: parsed.port,
      bearer: bearerSource,
      allowOrigins: parsed.allowOrigins,
      allowAnyOrigin: parsed.allowAnyOrigin,
      logger,
      onChildExit,
    })
    live.face = face
    return
  } catch (err) {
    await reap() // never-orphan before exiting on any fatal path
    logger.error('fatal', { code: err instanceof UnavailableError ? err.code : 'INTERNAL' })
    stderr.write(`${toMessage(err)}\n`)
    return exit(toExitCode(err))
  }
}

module.exports = { run, childExitToCode }

// Module side-effect entry: run when invoked as the program (not when required
// by a test). Bundled or executed directly, this is the program entrypoint.
if (require.main === module) {
  run().catch((err) => {
    process.stderr.write(`${toMessage(err)}\n`)
    process.exit(toExitCode(err))
  })
}
