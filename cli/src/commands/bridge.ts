/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transparent stdio ↔ WebSocket bridge for ACP agents and MCP servers.
 *
 * Spawns a local JSON-RPC-over-stdio process and exposes it over a WebSocket so
 * the in-browser app can reach it as a `remote-acp` agent / remote MCP server.
 * The pump is framing-aware on both edges:
 *   - WS → stdin: every WebSocket frame is exactly one JSON-RPC object (the app
 *     sends `JSON.stringify(msg)` per frame), so we forward it verbatim plus the
 *     trailing newline that the ndjson stdio framing requires.
 *   - stdout → WS: the process emits newline-delimited JSON, so we split on
 *     newlines and send each complete object as its own WebSocket frame — what
 *     the app's transport expects (`JSON.parse(event.data)` once per message).
 *
 * Lifecycle is 1:1: each WebSocket connection spawns its own dedicated process;
 * closing the socket kills the process, and a process exit closes the socket.
 * ACP and MCP share this exact pump (both speak ndjson JSON-RPC over stdio).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ServerWebSocket, Subprocess } from 'bun'
import type { BridgeConfig } from '../agent/types.ts'

/** Per-connection state: the spawned process this socket is pumping. `null`
 *  only in the instant between upgrade and `open` (or after a spawn failure). */
type BridgeSocketData = {
  proc: Subprocess<'pipe', 'pipe', 'inherit'> | null
}

type BridgeSocket = ServerWebSocket<BridgeSocketData>

/** A bridged stdio subprocess: piped stdin/stdout, inherited stderr. Shared by
 *  the WebSocket and iroh transports, which pump it identically. */
export type BridgeProc = Subprocess<'pipe', 'pipe', 'inherit'>

/** One-shot decoder for the rare binary inbound frame. Safe to share: it's only
 *  ever called without `{ stream: true }`, so it holds no cross-call state. The
 *  stdout pump deliberately uses its own decoder (streaming state must not be
 *  shared across concurrent connections). */
const frameDecoder = new TextDecoder()

/**
 * Pump a process's newline-delimited-JSON stdout to the socket, one JSON object
 * per WebSocket frame. Resolves when stdout closes (the process exited or was
 * killed). A trailing object without a final newline is flushed at close.
 */
const pumpStdoutToSocket = async (proc: BridgeProc, ws: BridgeSocket): Promise<void> => {
  // Per-pump decoder: `{ stream: true }` retains partial-multibyte state, which
  // would corrupt other connections if shared. Each connection gets its own.
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) ws.send(trimmed)
    }
  }
  buffer += decoder.decode()
  const trailing = buffer.trim()
  if (trailing) ws.send(trailing)
}

/**
 * Forward one inbound WebSocket frame to the agent's stdin, appending the newline
 * the ndjson stdio framing requires. The flush is awaited only so a flush-time
 * failure surfaces in the catch (not for WS-read backpressure — the caller fires
 * this off with `void`). A write/flush failure — most commonly `EPIPE` when a
 * frame arrives after the agent has exited and closed its stdin — is logged loudly
 * and closes the socket abnormally (1011) instead of throwing uncaught and downing
 * the bridge. Mirrors the iroh pump's `writeToStdin`: a dead pipe is a real IO
 * boundary, not a defensive guard on trusted data.
 */
export const forwardFrameToStdin = async (
  proc: BridgeProc,
  text: string,
  close: (code: number, reason: string) => void,
): Promise<void> => {
  try {
    proc.stdin.write(text + '\n')
    await proc.stdin.flush()
  } catch (err) {
    process.stderr.write(
      `thunderbolt bridge: stdin write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    close(1011, 'agent stdin closed')
  }
}

/** Spawn the bridged agent, returning `null` if the executable can't be found
 *  (the parser guarantees a non-empty command). Bun.spawn throws synchronously
 *  on ENOENT — catching it at this connection boundary keeps one bad command
 *  from killing the whole server, and surfaces the reason on the operator's
 *  stderr so the failure is loud rather than silent. */
export const spawnAgent = (command: readonly string[]): BridgeProc | null => {
  try {
    return Bun.spawn({ cmd: [...command], stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  } catch (err) {
    process.stderr.write(
      `thunderbolt bridge: failed to spawn '${command[0]}': ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }
}

/** Hard ceiling on concurrently-live bridged subprocesses per bridge server,
 *  shared by both transports. The handshake gates (rate limit + concurrent-
 *  handshake cap) bound *connection setup*, not established sessions — so an
 *  allowlisted/authorized peer holding many connections open would otherwise
 *  spawn unbounded long-lived agents and exhaust the host. At the cap a new
 *  connection is refused instead of spawning. Generous enough that real
 *  concurrent use never hits it. */
export const maxActiveProcs = 16

/** Whether a bridge is at its live-subprocess ceiling and must refuse new work.
 *  The single source of the cap policy for both the WebSocket and iroh bridges. */
export const atProcCapacity = (activeProcs: ReadonlySet<BridgeProc>): boolean => activeProcs.size >= maxActiveProcs

/** Bearer-style flags whose *following* argv element is a secret to hide. */
const secretFlags = new Set(['--api-key', '--token'])
/** An env-style `NAME=value` token whose NAME looks like a credential (ends in
 *  one of `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/`CRED(S)`, e.g.
 *  `OPENAI_API_KEY=sk-…`, `GITHUB_TOKEN=ghp_…`, `DB_SECRET=…`). Case-sensitive
 *  uppercase names only, so benign lowercase words like `monkey=foo` are left
 *  alone; the optional `[A-Z0-9_]*` prefix lets a bare `PASSWORD=…` match too. */
const keyAssignmentPattern = /^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDS?)=/

/** Redact the value of an env-style credential assignment, leaving its name. */
const redactKeyAssignment = (arg: string): string =>
  keyAssignmentPattern.test(arg) ? arg.replace(/=.*/s, '=***') : arg

/** Redact a joined `--flag=value` secret (e.g. `--api-key=sk-…` / `--token=ghp_…`),
 *  keeping the flag name and hiding everything after the first `=`. Returns `null`
 *  when the prefix isn't a secret flag, so callers can fall through. */
const redactJoinedFlag = (arg: string): string | null => {
  const eq = arg.indexOf('=')
  return eq !== -1 && secretFlags.has(arg.slice(0, eq)) ? `${arg.slice(0, eq)}=***` : null
}

/** Redact a single argv element in place: joined secret flag, else env assignment. */
const redactArg = (arg: string): string => redactJoinedFlag(arg) ?? redactKeyAssignment(arg)

/**
 * Render an argv as a single space-joined string with credentials redacted, for
 * logging the bridged command without leaking secrets to stdout/scrollback/CI.
 * Everything after `--` can carry a bearer token (e.g. an openai-compat agent's
 * `--api-key sk-…`); this hides the value following a bare `--api-key`/`--token`,
 * the tail of a joined `--api-key=sk-…`/`--token=…`, and any credential-looking
 * uppercase env assignment (`*KEY`/`*TOKEN`/`*SECRET`/`*PASSWORD`/…), replacing it
 * with `***`. Pure and total — a trailing bare secret
 * flag with no following value is simply left as-is.
 */
export const redactArgv = (argv: readonly string[]): string => {
  const out: string[] = []
  let hideNext = false
  for (const arg of argv) {
    if (hideNext) {
      out.push('***')
      hideNext = false
      continue
    }
    out.push(redactArg(arg))
    hideNext = secretFlags.has(arg)
  }
  return out.join(' ')
}

/** Origins the Thunderbolt app's webview presents as `Origin` on the WebSocket
 *  handshake: the Vite dev server plus the native Tauri webview origins (which
 *  vary by OS). A drive-by page the user visits in a normal browser cannot forge
 *  any of these. A self-hosted/cloud build adds its own origin(s) via the
 *  comma-separated `THUNDERBOLT_APP_ORIGIN`. */
const defaultAppOrigins = ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost'] as const

/**
 * The set of `Origin` header values allowed to upgrade the loopback bridge: the
 * built-in app origins plus any configured via `THUNDERBOLT_APP_ORIGIN`.
 */
export const bridgeAllowedOrigins = (): ReadonlySet<string> => {
  const configured = (process.env.THUNDERBOLT_APP_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
  return new Set([...defaultAppOrigins, ...configured])
}

/** Mint the per-run bridge secret: 256 bits of CSPRNG entropy, hex-encoded. It is
 *  printed once as the `token` query param of the listen URL and required on every
 *  upgrade, so only a client the user explicitly handed that URL to can connect. */
export const generateBridgeToken = (): string => randomBytes(32).toString('hex')

/** Constant-time token comparison. A length mismatch short-circuits to `false`
 *  (`timingSafeEqual` throws on unequal lengths); the token length is fixed and
 *  non-secret, so the early return leaks nothing exploitable. */
const tokensMatch = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Accept an upgrade, or reject it with an HTTP status + operator-facing reason. */
export type UpgradeDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly reason: string }

/**
 * Authorize a WebSocket upgrade for the loopback bridge. Three independent gates,
 * all required: the request path must be exactly `/`, the `Origin` header must be
 * an allowlisted Thunderbolt app origin, and the `token` query param must equal
 * the per-run secret (constant-time compared).
 *
 * This closes the drive-by host-access vector. The bridge spawns a host coding
 * agent per connection, and WebSocket upgrades bypass CORS — so without
 * these checks any site the user visits while the bridge runs could connect to
 * `ws://127.0.0.1:<port>` and drive arbitrary workspace access (the ACP permission
 * gate is useless against a malicious client that auto-approves). A drive-by page
 * can neither guess the token nor forge an allowlisted `Origin`, so it never
 * reaches `srv.upgrade`.
 */
export const authorizeUpgrade = (req: Request, token: string, allowedOrigins: ReadonlySet<string>): UpgradeDecision => {
  const url = new URL(req.url)
  if (url.pathname !== '/') return { ok: false, status: 404, reason: 'unknown path (only / is bridged)' }

  const origin = req.headers.get('origin')
  if (!origin || !allowedOrigins.has(origin)) {
    return { ok: false, status: 403, reason: `forbidden origin '${origin ?? '(none)'}'` }
  }

  const presented = url.searchParams.get('token')
  if (!presented || !tokensMatch(presented, token))
    return { ok: false, status: 401, reason: 'missing or invalid token' }

  return { ok: true }
}

/**
 * Start the bridge server: listen for WebSocket connections and pump each one
 * to its own freshly-spawned `config.command` process. Returns once the server
 * is listening; the live server keeps the process alive until interrupted.
 */
export const runBridge = async (config: BridgeConfig): Promise<void> => {
  const token = generateBridgeToken()
  const allowedOrigins = bridgeAllowedOrigins()
  // Cap concurrently-live agents: the upgrade gate authorizes *connections*, not
  // sessions, so an authorized client holding many sockets open would otherwise
  // spawn unbounded agent processes. At the ceiling a new socket is refused.
  const activeProcs = new Set<BridgeProc>()
  const server = Bun.serve<BridgeSocketData>({
    // Loopback-only: this transport is unauthenticated, so it must not be
    // reachable from the LAN (Bun's default binds every interface). The G3
    // consumer is the app running on the same machine; authenticated remote
    // access is the separate iroh transport (G4).
    hostname: '127.0.0.1',
    port: config.port,
    fetch(req, srv) {
      // Loopback alone is not a security boundary: WebSocket upgrades bypass CORS,
      // so any page the user visits can reach this port. Gate every upgrade on an
      // allowlisted Origin + the unguessable per-run token before spawning an agent.
      const decision = authorizeUpgrade(req, token, allowedOrigins)
      if (!decision.ok) return new Response(`thunderbolt bridge: ${decision.reason}\n`, { status: decision.status })
      if (srv.upgrade(req, { data: { proc: null } })) return undefined
      return new Response('thunderbolt bridge: WebSocket endpoint only\n', { status: 426 })
    },
    websocket: {
      open(ws) {
        if (atProcCapacity(activeProcs)) {
          ws.close(1013, 'bridge at capacity')
          return
        }
        const proc = spawnAgent(config.command)
        if (!proc) {
          ws.close(1011, `failed to spawn '${config.command[0]}'`)
          return
        }
        activeProcs.add(proc)
        void proc.exited.then(() => activeProcs.delete(proc))
        ws.data.proc = proc
        void (async () => {
          try {
            await pumpStdoutToSocket(proc, ws)
          } catch (err) {
            process.stderr.write(
              `thunderbolt bridge: stdout pump error: ${err instanceof Error ? err.message : String(err)}\n`,
            )
          }
        })()
        void (async () => {
          const code = await proc.exited
          // 1000 (normal) only on a clean exit; a non-zero/killed exit is an
          // abnormal close (1011) so the app surfaces it instead of seeing
          // a successful shutdown.
          ws.close(code === 0 ? 1000 : 1011, `agent exited (code ${code})`)
        })()
      },
      message(ws, message) {
        const proc = ws.data.proc
        if (!proc) return
        const text = typeof message === 'string' ? message : frameDecoder.decode(message)
        void forwardFrameToStdin(proc, text, (code, reason) => ws.close(code, reason))
      },
      close(ws) {
        ws.data.proc?.kill()
      },
    },
  })

  // A signal stops the server with `closeActiveConnections`, which fires each
  // socket's `close` handler and so kills every spawned agent before exit.
  const shutdown = (): void => {
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Advertise the exact bound address (not `localhost`, which can resolve to
  // the IPv6 `::1` and miss this IPv4-only loopback bind). The token rides in the
  // URL, so pasting it whole into the app authenticates with no client change.
  const url = `ws://127.0.0.1:${server.port}/?token=${token}`
  process.stdout.write(
    `⚡ thunderbolt ${config.protocol} bridge (${config.transport}) listening on ws://127.0.0.1:${server.port}\n` +
      `   spawning per connection: ${redactArgv(config.command)}\n` +
      `   set this as the agent URL in the app (includes the access token): ${url}\n`,
  )
}
