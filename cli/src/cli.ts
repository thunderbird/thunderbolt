/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Command-line surface for the thunderbolt CLI: version, help text, and the
 * pure `parseArgs` that turns `Bun.argv.slice(2)` into a {@link ParsedArgs}.
 * No I/O happens here — the caller decides what to do with the result.
 */

import type { BridgeConfig, BridgeProtocol, ParsedArgs, RunConfig, ThinkingLevel } from './agent/types.ts'

/** Released version of the CLI, surfaced by `--version` and the banner. */
export const VERSION = '0.1.0'

/** Default Anthropic model when `--model` is omitted. */
const DEFAULT_MODEL = 'claude-opus-4-8'

/** All valid `--thinking` levels, in increasing depth. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/** The only `--transport` value supported today. `iroh` (P2P) is planned. */
const SUPPORTED_TRANSPORT = 'wss'

/** Default `--port` per bridge protocol — distinct so `acp` and `mcp` bridges
 *  can run side by side without colliding on their defaults. */
const DEFAULT_BRIDGE_PORT: Record<BridgeProtocol, number> = { acp: 8839, mcp: 8840 }

/** Usage text printed by `--help`/`-h`. */
export const HELP_TEXT = `⚡ thunderbolt v${VERSION} — a single-binary terminal coding agent.

USAGE
  thunderbolt [options] [prompt]
  thunderbolt agent [options] [prompt]
  thunderbolt acp --transport ${SUPPORTED_TRANSPORT} [--port N] -- <agent-cmd...>
  thunderbolt mcp --transport ${SUPPORTED_TRANSPORT} [--port N] -- <server-cmd...>

  With a prompt, runs it once and exits. With no prompt, starts an
  interactive REPL. Built on the Pi harness; talks to Claude.

SUBCOMMANDS
  agent   run the coding agent (default when omitted)
  acp     bridge a local stdio ACP agent onto a WebSocket the app can reach
  mcp     bridge a local stdio MCP server onto a WebSocket the app can reach

TOOLS
  bash    run shell commands
  read    read a file
  write   create or overwrite a file
  edit    replace a span within a file

OPTIONS
  -m, --model <id>      Anthropic model id (default: ${DEFAULT_MODEL})
      --thinking <lvl>  reasoning depth: ${THINKING_LEVELS.join(' | ')} (default: medium)
  -y, --yolo            auto-approve every tool call (alias:
                        --dangerously-skip-permissions)
  -h, --help            show this help and exit
  -v, --version         print the version and exit

BRIDGE OPTIONS (acp / mcp)
      --transport <t>   network transport: ${SUPPORTED_TRANSPORT} (default: ${SUPPORTED_TRANSPORT})
      --port <n>        listen port (default: acp ${DEFAULT_BRIDGE_PORT.acp}, mcp ${DEFAULT_BRIDGE_PORT.mcp})
      --                everything after this is the stdio command to spawn

EXAMPLES
  thunderbolt "fix the failing test in utils.ts"
  thunderbolt --thinking high "refactor the auth module"
  thunderbolt --yolo "run the test suite and fix what breaks"
  thunderbolt
  thunderbolt acp --transport ${SUPPORTED_TRANSPORT} -- npx @zed-industries/claude-code-acp
  thunderbolt mcp --transport ${SUPPORTED_TRANSPORT} --port 9001 -- uvx mcp-server-fetch

Requires ANTHROPIC_API_KEY (https://console.anthropic.com).`

/** Type guard: is `value` one of the supported {@link ThinkingLevel}s? */
const isThinkingLevel = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value)

/** Flag/positional state accumulated while scanning argv. */
type Flags = {
  readonly model: string
  readonly yolo: boolean
  readonly thinking: ThinkingLevel
  readonly positionals: readonly string[]
}

const DEFAULT_FLAGS: Flags = {
  model: DEFAULT_MODEL,
  yolo: false,
  thinking: 'medium',
  positionals: [],
}

/** Outcome of scanning argv: resolved flags, or a parse error message. */
type ScanResult = { readonly ok: true; readonly flags: Flags } | { readonly ok: false; readonly message: string }

/**
 * Recursively folds the token stream into {@link Flags}. Value-taking flags
 * consume the following token; anything unrecognized becomes a positional.
 */
const scanTokens = (tokens: readonly string[], index: number, flags: Flags): ScanResult => {
  if (index >= tokens.length) return { ok: true, flags }

  const token = tokens[index]
  const next = tokens[index + 1]

  if (token === '--model' || token === '-m') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --model requires a value' }
    return scanTokens(tokens, index + 2, { ...flags, model: next })
  }

  if (token === '--thinking') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --thinking requires a value' }
    if (!isThinkingLevel(next)) {
      return {
        ok: false,
        message: `thunderbolt: invalid --thinking level '${next}' (expected one of: ${THINKING_LEVELS.join(', ')})`,
      }
    }
    return scanTokens(tokens, index + 2, { ...flags, thinking: next })
  }

  if (token === '--yolo' || token === '-y' || token === '--dangerously-skip-permissions') {
    return scanTokens(tokens, index + 1, { ...flags, yolo: true })
  }

  return scanTokens(tokens, index + 1, { ...flags, positionals: [...flags.positionals, token] })
}

/** Bridge flag state accumulated while scanning the tokens before `--`. */
type BridgeFlags = { readonly transport: 'wss'; readonly port: number }

type BridgeScanResult =
  | { readonly ok: true; readonly flags: BridgeFlags }
  | { readonly ok: false; readonly message: string }

/**
 * Folds the bridge flag tokens (everything before the `--` separator) into
 * {@link BridgeFlags}. Only `--transport` and `--port` are recognized; an
 * unknown token is reported as a likely missing `--` before the agent command.
 */
const scanBridgeFlags = (tokens: readonly string[], index: number, flags: BridgeFlags): BridgeScanResult => {
  if (index >= tokens.length) return { ok: true, flags }

  const token = tokens[index]
  const next = tokens[index + 1]

  if (token === '--transport') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --transport requires a value' }
    if (next === 'iroh') {
      return { ok: false, message: "thunderbolt: --transport 'iroh' is not available yet (P2P transport is planned); use 'wss'" }
    }
    if (next !== SUPPORTED_TRANSPORT) {
      return { ok: false, message: `thunderbolt: invalid --transport '${next}' (only '${SUPPORTED_TRANSPORT}' is supported)` }
    }
    return scanBridgeFlags(tokens, index + 2, { ...flags, transport: SUPPORTED_TRANSPORT })
  }

  if (token === '--port') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --port requires a value' }
    // Digits-only so `0x10`/`1e3`/` 5 ` don't slip past `Number` coercion.
    if (!/^\d+$/.test(next) || Number(next) > 65535) {
      return { ok: false, message: `thunderbolt: invalid --port '${next}' (expected an integer 0-65535)` }
    }
    return scanBridgeFlags(tokens, index + 2, { ...flags, port: Number(next) })
  }

  return { ok: false, message: `thunderbolt: unrecognized bridge option '${token}' (did you forget '--' before the command?)` }
}

/**
 * Parses an `acp`/`mcp` bridge invocation. Splits the tokens at the first `--`
 * separator: flags before it, the stdio command to spawn after it.
 */
const parseBridgeArgs = (protocol: BridgeProtocol, rest: string[]): ParsedArgs => {
  const separator = rest.indexOf('--')
  const flagTokens = separator === -1 ? rest : rest.slice(0, separator)
  const command = separator === -1 ? [] : rest.slice(separator + 1)

  if (flagTokens.includes('--help') || flagTokens.includes('-h')) return { kind: 'help' }

  const scan = scanBridgeFlags(flagTokens, 0, { transport: SUPPORTED_TRANSPORT, port: DEFAULT_BRIDGE_PORT[protocol] })
  if (!scan.ok) return { kind: 'error', message: scan.message }

  if (command.length === 0) {
    return {
      kind: 'error',
      message: `thunderbolt ${protocol}: missing agent command (e.g. thunderbolt ${protocol} --transport ${SUPPORTED_TRANSPORT} -- <command...>)`,
    }
  }

  const config: BridgeConfig = { protocol, transport: scan.flags.transport, port: scan.flags.port, command }
  return { kind: 'bridge', config }
}

/**
 * Parses CLI arguments (already stripped of runtime/script — pass
 * `Bun.argv.slice(2)`) into a {@link ParsedArgs}. Pure: no I/O, no exits.
 *
 * @param argv - the raw argument tokens
 * @returns a terminal info action (`help`/`version`/`error`), a `run` with a
 *   fully-resolved {@link RunConfig}, or a `bridge` with a {@link BridgeConfig}
 */
export const parseArgs = (argv: string[]): ParsedArgs => {
  const subcommand = argv[0]
  if (subcommand === 'acp' || subcommand === 'mcp') return parseBridgeArgs(subcommand, argv.slice(1))

  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' }
  if (argv.includes('--version') || argv.includes('-v')) return { kind: 'version' }

  const tokens = subcommand === 'agent' ? argv.slice(1) : argv
  const scan = scanTokens(tokens, 0, DEFAULT_FLAGS)
  if (!scan.ok) return { kind: 'error', message: scan.message }

  const prompt = scan.flags.positionals.join(' ')
  const base = {
    model: scan.flags.model,
    cwd: process.cwd(),
    yolo: scan.flags.yolo,
    thinking: scan.flags.thinking,
  }
  const config: RunConfig = prompt.length > 0 ? { ...base, mode: 'oneshot', prompt } : { ...base, mode: 'repl' }
  return { kind: 'run', config }
}
