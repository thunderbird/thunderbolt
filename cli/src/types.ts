/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Single source of truth for the cross-module boundary types of the thunderbolt
// bridge. Every type here describes a shape that flows BETWEEN modules (an
// options bag, a returned handle/controller, a callback signature, or a parsed
// frame) — never a module-private implementation detail. This file is purely
// type-level (no runtime values), so esbuild erases it entirely from the bundle.

import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// JSON-RPC frames + the NDJSON relay (relay.js, log.js, mcp-multiplexer.js)
// ---------------------------------------------------------------------------

/** A JSON-RPC request/response id. */
export type JsonRpcId = string | number

/**
 * A loosely-typed JSON-RPC frame as it crosses the bridge. Every field is
 * optional because the same shape covers requests, responses, and
 * notifications; payload fields are intentionally `unknown` (the bridge never
 * inspects them beyond `method`/`id` routing).
 */
export type JsonRpcMessage = {
  jsonrpc?: string
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

/** Per-line callback the NDJSON reader invokes for each complete line. */
export type LineHandler = (line: string) => void

/**
 * Incremental NDJSON splitter returned by `createNdjsonReader`. `push` feeds a
 * raw chunk; `flush` emits any trailing unterminated line.
 */
export type NdjsonReader = {
  push: (chunk: Buffer | string) => void
  flush: () => void
}

/** Non-identifying shape token for a frame's id (never the id value itself). */
export type FrameIdKind = 'request' | 'response' | 'notification' | 'absent'

/** PII-safe classification of a frame: only its method name + id shape token. */
export type ClassifiedFrame = {
  method: string
  id: FrameIdKind
}

// ---------------------------------------------------------------------------
// Exit codes + error options (errors.js)
// ---------------------------------------------------------------------------

/** Canonical sysexits exit codes the bridge can produce. */
export type ExitCode = 0 | 64 | 69 | 70 | 130

/** A child process's terminal outcome, as reported by the supervisor. */
export type ChildExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

/** Constructor options for an `UnavailableError` (carries a Node error code). */
export type UnavailableErrorOptions = {
  code?: string
  message?: string
}

// ---------------------------------------------------------------------------
// Logger (log.js)
// ---------------------------------------------------------------------------

/**
 * Structured fields a log call may carry. `undefined` values are tolerated (the
 * logger drops non-scalars, including `undefined`, before emitting).
 */
export type LogFields = Record<string, string | number | boolean | undefined>

/** PII-safe structured logger written to the injected stderr sink. */
export type Logger = {
  info: (event: string, fields?: LogFields) => void
  warn: (event: string, fields?: LogFields) => void
  error: (event: string, fields?: LogFields) => void
  banner: (url: string) => void
}

/** Options for `makeLogger`. */
export type LoggerOptions = {
  json: boolean
  verbose: boolean
  sink: NodeJS.WritableStream
}

/** Options for `buildOriginAllowlist`. */
export type OriginAllowlistOptions = {
  allowOrigins: string[]
  allowAnyOrigin: boolean
}

/** The Origin gate predicate returned by `buildOriginAllowlist`. */
export type OriginAllowlist = (origin: string | undefined) => boolean

// ---------------------------------------------------------------------------
// Parsed CLI args (args.js)
// ---------------------------------------------------------------------------

/** The bridge face the child stdio server is exposed as. */
export type Mode = 'acp' | 'mcp'

/** A fully-resolved `bridge` options object (the parser's success result). */
export type ParsedArgs = {
  mode: Mode
  host: string
  port: number
  allowOrigins: string[]
  allowAnyOrigin: boolean
  tunnel: boolean
  json: boolean
  verbose: boolean
  launch: string[]
}

/** Resolved bridge opts tagged with their subcommand for the dispatcher. */
export type BridgeCommand = ParsedArgs & { command: 'bridge' }

/** A request to print help text, keyed by the help topic. */
export type HelpIntent = { help: 'root' | 'bridge' }

/** A request to print the version. */
export type VersionIntent = { version: true }

/** What `parseBridgeArgs` returns: resolved opts or a help/version intent. */
export type ParseBridgeResult = ParsedArgs | { help: 'bridge' } | VersionIntent

/** What `parseArgs` returns: a resolved subcommand or a help/version intent. */
export type ParseArgsResult = BridgeCommand | HelpIntent | VersionIntent

// ---------------------------------------------------------------------------
// Shared util seams (util.js)
// ---------------------------------------------------------------------------

/**
 * A resolve-once close latch shared by both faces so never-orphan teardown
 * semantics can't drift between them.
 */
export type CloseLatch = {
  finishClose: () => void
  setResolver: (fn: () => void) => void
  settled: () => boolean
}

/** Inputs to `insecureFlagWarnings` (a subset of the parsed bridge args). */
export type InsecureFlagOptions = {
  host: string
  allowAnyOrigin: boolean
  tunnel: boolean
}

// ---------------------------------------------------------------------------
// Injectable runtime collaborators
// ---------------------------------------------------------------------------

/** Injectable `child_process.spawn`. */
export type SpawnFn = typeof import('node:child_process').spawn

/** Injectable `http.createServer`. */
export type CreateServerFn = typeof import('node:http').createServer

/** Injectable `ws` `WebSocketServer` constructor. */
export type WebSocketServerClass = typeof import('ws').WebSocketServer

// ---------------------------------------------------------------------------
// Child supervisor (child.js)
// ---------------------------------------------------------------------------

/** Options for `superviseChild`. */
export type SuperviseChildOptions = {
  launch: string[]
  spawn?: SpawnFn
  onStdout: (chunk: Buffer) => void
  onExit: (info: ChildExit) => void
  onSpawnError: (err: NodeJS.ErrnoException) => void
  logger: Pick<Logger, 'error'>
  graceMs?: number
}

/**
 * The controller `superviseChild` returns: the spawned child plus the controls
 * the ACP/MCP faces drive it with (stdin write with backpressure return,
 * pause/resume stdout, graceful stop, immediate kill, liveness probe).
 */
export type ChildSupervisor = {
  child: ChildProcess
  writeStdin: (chunk: string | Buffer) => boolean
  pauseStdout: () => void
  resumeStdout: () => void
  stop: (signal?: NodeJS.Signals) => void
  kill: () => void
  alive: () => boolean
}

/** The `superviseChild` function signature (used as an injectable dep). */
export type SuperviseChild = (opts: SuperviseChildOptions) => ChildSupervisor

// ---------------------------------------------------------------------------
// MCP transports (mcp-multiplexer.js, mcp-server.js)
// ---------------------------------------------------------------------------

/**
 * The structural slice of a `StreamableHTTPServerTransport` the bridge drives:
 * the inbound `onmessage` hook, outbound `send`, `close`, and the HTTP
 * `handleRequest` entry. Kept structural so the multiplexer never couples to the
 * SDK directly (it receives the class as a parameter).
 */
export type McpTransport = {
  onmessage?: (message: JsonRpcMessage) => void
  send: (message: JsonRpcMessage) => Promise<void>
  close: () => void
  handleRequest: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
}

/** A stateless-transport constructor (the SDK class or an injected fake). */
export type McpTransportClass = new (opts: { sessionIdGenerator: undefined }) => McpTransport

// ---------------------------------------------------------------------------
// MCP multiplexer (mcp-multiplexer.js)
// ---------------------------------------------------------------------------

/** Options for `createMultiplexer`. */
export type MultiplexerOptions = {
  writeChild: (frame: string) => void
  logger: Pick<Logger, 'warn'>
}

/**
 * The bridge-owned multiplexer that fans many per-request transports onto the
 * one stdio child: mints transports, releases them, routes child stdout back to
 * the owning client(s), and closes everything on teardown.
 */
export type Multiplexer = {
  createTransport: (TransportClass: McpTransportClass) => McpTransport
  releaseTransport: (transport: McpTransport) => void
  onChildMessage: (message: JsonRpcMessage) => void
  closeAll: () => void
}

// ---------------------------------------------------------------------------
// Faces: ACP WebSocket (server.js) + MCP Streamable HTTP (mcp-server.js)
// ---------------------------------------------------------------------------

/** The handle both faces resolve with: the bound URL plus teardown controls. */
export type FaceHandle = {
  url: string
  kill: () => void
  close: () => Promise<void>
}

/** Injectable collaborators for the ACP face. */
export type BridgeDeps = {
  WebSocketServer?: WebSocketServerClass
  spawn?: SpawnFn
  superviseChild?: SuperviseChild
}

/** Options for `startBridge` (the ACP WebSocket face). */
export type BridgeOptions = {
  launch: string[]
  host: string
  port: number
  allowOrigins: string[]
  allowAnyOrigin: boolean
  logger: Logger
  onChildExit?: (info: ChildExit) => void
  deps?: BridgeDeps
}

/** Injectable collaborators for the MCP face. */
export type McpFaceDeps = {
  createServer?: CreateServerFn
  StreamableHTTPServerTransport?: McpTransportClass
  superviseChild?: SuperviseChild
  spawn?: SpawnFn
}

/** Options for `startMcpFace` (the MCP Streamable HTTP face). */
export type McpFaceOptions = {
  launch: string[]
  host: string
  port: number
  bearer?: string
  allowOrigins: string[]
  allowAnyOrigin: boolean
  bodyCapBytes?: number
  logger: Logger
  onChildExit?: (info: ChildExit) => void
  deps?: McpFaceDeps
}

/** The `startBridge` function signature (used as an injectable dep). */
export type StartBridge = (opts: BridgeOptions) => Promise<FaceHandle>

/** The `startMcpFace` function signature (used as an injectable dep). */
export type StartMcpFace = (opts: McpFaceOptions) => Promise<FaceHandle>

// ---------------------------------------------------------------------------
// Cloudflared tunnel (tunnel.js)
// ---------------------------------------------------------------------------

/** Options for `startTunnel`. */
export type TunnelOptions = {
  localUrl: string
  bearer: string
  logger: Logger
  spawn?: SpawnFn
  urlTimeoutMs?: number
}

/** The handle `startTunnel` resolves with once cloudflared reports its URL. */
export type TunnelHandle = {
  publicUrl: string
  bearer: string
  close: () => Promise<void>
}

/** The `startTunnel` function signature (used as an injectable dep). */
export type StartTunnel = (opts: TunnelOptions) => Promise<TunnelHandle>

/** The `generateBearer` function signature (used as an injectable dep). */
export type GenerateBearer = (randomBytes?: (size: number) => Buffer) => string

/** The `makeLogger` function signature (used as an injectable dep). */
export type MakeLogger = (opts: LoggerOptions) => Logger
