/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Command-line surface for the thunderbolt CLI: version, help text, and the
 * pure `parseArgs` that turns `Bun.argv.slice(2)` into a {@link ParsedArgs}.
 * No I/O happens here — the caller decides what to do with the result.
 */

import packageJson from '../package.json' with { type: 'json' }
import { isProvider, modelProviders } from './agent/types.ts'
import { defaultModel, defaultModels, defaultProvider, hasProviderEnvKey } from './agent/defaults.ts'
import type {
  BridgeConfig,
  BridgeProtocol,
  BridgeTransport,
  ModelProvider,
  ParsedArgs,
  RunConfig,
  ServeConfig,
  ThinkingLevel,
} from './agent/types.ts'
import type { CliConfig } from './config/config.ts'
import { defaultCloudUrl } from './auth/config.ts'

/** Released version of the CLI, surfaced by `--version` and the banner. */
export const cliVersion = packageJson.version

/** All valid `--thinking` levels, in increasing depth. */
const thinkingLevels: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/** Default `--transport` when omitted (loopback WebSocket). */
const defaultTransport: BridgeTransport = 'wss'

/** All supported `--transport` values: `wss` (loopback) and `iroh` (P2P/E2E). */
const transports: readonly BridgeTransport[] = ['wss', 'iroh']

/** Default `--port` per bridge protocol — distinct so `acp` and `mcp` bridges
 *  can run side by side without colliding on their defaults. */
const defaultBridgePort: Record<BridgeProtocol, number> = { acp: 8839, mcp: 8840 }

/** Usage text printed by `--help`/`-h`. */
export const helpText = `⚡ thunderbolt v${cliVersion} — a single-binary terminal coding agent.

USAGE
  thunderbolt [options] [prompt]
  thunderbolt agent [options] [prompt]
  thunderbolt config
  thunderbolt login
  thunderbolt acp serve [options]
  thunderbolt acp --transport <wss|iroh> [--port N] -- <agent-cmd...>
  thunderbolt mcp --transport <wss|iroh> [--port N] -- <server-cmd...>
  thunderbolt acp connect <ticket|nodeid> [-- <local-client-cmd...>]
  thunderbolt iroh <id | pair | allow <nodeid>>

  With a prompt, runs it once and exits. With no prompt, starts an
  interactive REPL. Built on the Pi harness; supports multiple model providers.

SUBCOMMANDS
  agent       run the coding agent (default when omitted)
  config      run guided provider setup and overwrite saved CLI defaults
  login       authenticate this CLI with your Thunderbolt account (device grant)
  acp serve   expose THIS coding agent, rooted at current directory, as a stdio ACP server
  acp         bridge a local stdio ACP agent over the network the app can reach
  mcp         bridge a local stdio MCP server over the network the app can reach
  iroh        manage the P2P identity / pairing ticket / peer allowlist

TOOLS
  bash    run shell commands
  read    read a file
  write   create or overwrite a file
  edit    replace a span within a file

OPTIONS
  -m, --model <id>      model id (default: provider-specific;
                        anthropic uses ${defaultModel})
      --provider <p>    model backend: ${modelProviders.join(' | ')} (default: ${defaultProvider})
      --base-url <url>  OpenAI-compatible base URL (required for openai-compat)
      --api-key <key>   explicit provider api key (flag wins over provider env)
      --thinking <lvl>  reasoning depth: ${thinkingLevels.join(' | ')} (default: medium)
  -y, --yolo            auto-approve every tool call (alias:
                        --dangerously-skip-permissions)
      --no-tui          use the plain readline REPL, not the interactive TUI
                        (the TUI is the default when stdout is a terminal)
  -h, --help            show this help and exit
  -v, --version         print the version and exit

BRIDGE OPTIONS (acp / mcp)
      --transport <t>   network transport: ${transports.join(' | ')} (default: ${defaultTransport})
      --port <n>        listen port, wss only (default: acp ${defaultBridgePort.acp}, mcp ${defaultBridgePort.mcp})
      --                everything after this is the stdio command to spawn

IROH TRANSPORT (P2P, end-to-end encrypted)
  thunderbolt iroh id                print the ACP bridge NodeId + connection ticket
  thunderbolt iroh pair              print an ACP ticket to share out-of-band
  thunderbolt iroh allow <nodeid>    trust a peer (the allowlist is the auth gate)
  Only allowlisted peers may drive an iroh bridge; the NodeId is an ed25519 key,
  so the QUIC handshake authenticates and end-to-end encrypts every session.
  iroh id|pair are ACP-only — the MCP bridge has its own NodeId, printed by
  thunderbolt mcp --transport iroh on startup.

LOGIN (device authorization grant)
  thunderbolt login    open the printed link (or scan the QR) and approve in the
                       app to bind this CLI to your account. Set THUNDERBOLT_CLOUD_URL
                       to point at a self-hosted backend (default ${defaultCloudUrl}),
                       or THUNDERBOLT_TOKEN to a PAT to skip the interactive flow (CI).

EXAMPLES
  thunderbolt "fix the failing test in utils.ts"
  thunderbolt --thinking high "refactor the auth module"
  thunderbolt --yolo "run the test suite and fix what breaks"
  OPENAI_API_KEY=sk-… thunderbolt --provider openai "fix the failing tests"
  thunderbolt --provider google --api-key AIza… "review this repository"
  thunderbolt config
  thunderbolt
  THUNDERBOLT_OPENAI_COMPAT_KEY=local thunderbolt --provider openai-compat --base-url http://localhost:11434/v1 --model llama3.3 "hello"
  thunderbolt acp --transport wss -- npx @zed-industries/claude-code-acp
  thunderbolt mcp --transport wss --port 9001 -- uvx mcp-server-fetch
  thunderbolt acp --transport iroh -- thunderbolt acp serve   # share THIS agent
  thunderbolt acp --transport iroh -- npx @zed-industries/claude-code-acp
  thunderbolt iroh id
  thunderbolt acp connect endpoint1abc…   # dial a remote iroh bridge

Provider, model, key, and custom URL defaults can be saved in
~/.thunderbolt/config.json (or $THUNDERBOLT_HOME/config.json). Resolution order
is flag, provider environment variable, config, then built-in default. Run
thunderbolt in a terminal for guided first-run setup, or thunderbolt config to
reconfigure. openai-compat never reads generic provider keys.`

/** Type guard: is `value` one of the supported {@link ThinkingLevel}s? */
const isThinkingLevel = (value: string): value is ThinkingLevel => (thinkingLevels as readonly string[]).includes(value)

/** Flag/positional state accumulated while scanning argv. */
type Flags = {
  readonly model?: string
  readonly yolo: boolean
  readonly noTui: boolean
  readonly thinking: ThinkingLevel
  readonly provider?: ModelProvider
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly positionals: readonly string[]
}

const defaultFlags: Flags = {
  yolo: false,
  noTui: false,
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

  if (token === '--provider') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --provider requires a value' }
    if (!isProvider(next)) {
      return {
        ok: false,
        message: `thunderbolt: invalid --provider '${next}' (expected one of: ${modelProviders.join(', ')})`,
      }
    }
    return scanTokens(tokens, index + 2, { ...flags, provider: next })
  }

  if (token === '--base-url') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --base-url requires a value' }
    return scanTokens(tokens, index + 2, { ...flags, baseUrl: next })
  }

  if (token === '--api-key') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --api-key requires a value' }
    return scanTokens(tokens, index + 2, { ...flags, apiKey: next })
  }

  if (token === '--thinking') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --thinking requires a value' }
    if (!isThinkingLevel(next)) {
      return {
        ok: false,
        message: `thunderbolt: invalid --thinking level '${next}' (expected one of: ${thinkingLevels.join(', ')})`,
      }
    }
    return scanTokens(tokens, index + 2, { ...flags, thinking: next })
  }

  if (token === '--yolo' || token === '-y' || token === '--dangerously-skip-permissions') {
    return scanTokens(tokens, index + 1, { ...flags, yolo: true })
  }

  if (token === '--no-tui') {
    return scanTokens(tokens, index + 1, { ...flags, noTui: true })
  }

  return scanTokens(tokens, index + 1, { ...flags, positionals: [...flags.positionals, token] })
}

/** Bridge flag state accumulated while scanning the tokens before `--`. */
type BridgeFlags = { readonly transport: BridgeTransport; readonly port: number }

type BridgeScanResult =
  | { readonly ok: true; readonly flags: BridgeFlags }
  | { readonly ok: false; readonly message: string }

/** Type guard: is `value` a supported {@link BridgeTransport}? */
const isTransport = (value: string): value is BridgeTransport => (transports as readonly string[]).includes(value)

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
    if (!isTransport(next)) {
      return {
        ok: false,
        message: `thunderbolt: invalid --transport '${next}' (expected one of: ${transports.join(', ')})`,
      }
    }
    return scanBridgeFlags(tokens, index + 2, { ...flags, transport: next })
  }

  if (token === '--port') {
    if (next === undefined) return { ok: false, message: 'thunderbolt: --port requires a value' }
    // Digits-only so `0x10`/`1e3`/` 5 ` don't slip past `Number` coercion.
    if (!/^\d+$/.test(next) || Number(next) > 65535) {
      return { ok: false, message: `thunderbolt: invalid --port '${next}' (expected an integer 0-65535)` }
    }
    return scanBridgeFlags(tokens, index + 2, { ...flags, port: Number(next) })
  }

  return {
    ok: false,
    message: `thunderbolt: unrecognized bridge option '${token}' (did you forget '--' before the command?)`,
  }
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

  const scan = scanBridgeFlags(flagTokens, 0, { transport: defaultTransport, port: defaultBridgePort[protocol] })
  if (!scan.ok) return { kind: 'error', message: scan.message }

  if (command.length === 0) {
    return {
      kind: 'error',
      message: `thunderbolt ${protocol}: missing agent command (e.g. thunderbolt ${protocol} --transport ${defaultTransport} -- <command...>)`,
    }
  }

  const config: BridgeConfig = { protocol, transport: scan.flags.transport, port: scan.flags.port, command }
  return { kind: 'bridge', config }
}

/**
 * Parses an `acp`/`mcp connect` invocation: dial a remote iroh bridge by ticket
 * or NodeId, optionally spawning a local client after `--`. The first token is
 * the dial target; everything after `--` is the local stdio command.
 */
const parseConnectArgs = (protocol: BridgeProtocol, rest: string[]): ParsedArgs => {
  const separator = rest.indexOf('--')
  const before = separator === -1 ? rest : rest.slice(0, separator)
  const command = separator === -1 ? [] : rest.slice(separator + 1)

  if (before.includes('--help') || before.includes('-h')) return { kind: 'help' }

  const target = before[0]
  if (target === undefined) {
    return { kind: 'error', message: `thunderbolt ${protocol} connect: missing <ticket|nodeid> to dial` }
  }
  if (before.length > 1) {
    return {
      kind: 'error',
      message: `thunderbolt ${protocol} connect: unexpected argument '${before[1]}' (did you forget '--' before the command?)`,
    }
  }

  return { kind: 'connect', config: { protocol, target, command } }
}

/** Injectable inputs for deterministic config and environment resolution. */
export type ParseArgsDependencies = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly config?: CliConfig | null
  readonly cwd?: string
}

type ResolvedDependencies = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly config: CliConfig | null
  readonly cwd: string
}

/** Fills omitted parser dependencies from current process state. */
const resolveDependencies = (dependencies: ParseArgsDependencies): ResolvedDependencies => ({
  env: dependencies.env ?? process.env,
  config: dependencies.config ?? null,
  cwd: dependencies.cwd ?? process.cwd(),
})

/** Resolves provider flag against saved provider and built-in default. */
const resolveProvider = (flags: Flags, config: CliConfig | null): ModelProvider =>
  flags.provider ?? config?.provider ?? defaultProvider

/**
 * Resolves an explicit provider key. Every provider accepts `--api-key`, while
 * only openai-compat reads a CLI-level fallback environment variable.
 *
 * Deliberately scoped to a dedicated var rather than falling back to a standard
 * key like `OPENAI_API_KEY`: openai-compat sends this key to an arbitrary
 * `--base-url`, so auto-forwarding a real OpenAI key to a third-party host would
 * leak credentials. `THUNDERBOLT_OPENAI_COMPAT_KEY` is the explicit opt-in for
 * "this key is meant for whatever host I point at".
 *
 * @param provider - selected model provider
 * @param flagApiKey - value passed via `--api-key`, if any
 * @param effectiveBaseUrl - endpoint selected after flag and config precedence
 * @returns the resolved api key, or `undefined`
 */
const resolveApiKey = (
  provider: ModelProvider,
  flagApiKey: string | undefined,
  effectiveBaseUrl: string | undefined,
  dependencies: ResolvedDependencies,
): string | undefined => {
  if (flagApiKey !== undefined) return flagApiKey
  const config = dependencies.config
  if (provider === 'openai-compat') {
    // `||`, not `??`: an empty env string is not a usable credential.
    const envKey = dependencies.env.THUNDERBOLT_OPENAI_COMPAT_KEY
    if (envKey) return envKey
    // The saved key only applies to the endpoint it was saved for.
    if (config?.provider === provider && effectiveBaseUrl === config.baseUrl) return config.apiKey
    return undefined
  }

  if (hasProviderEnvKey(provider, dependencies.env)) return undefined
  return config?.provider === provider ? config.apiKey : undefined
}

/**
 * Resolves omitted `--model` against saved config and the provider's catalog
 * default. Returns `null` for openai-compat with no saved model: the endpoint
 * is arbitrary, so guessing a catalog id would only fail upstream with a
 * confusing provider error.
 */
const resolveModelId = (flags: Flags, provider: ModelProvider, config: CliConfig | null): string | null => {
  if (flags.model !== undefined) return flags.model
  if (config?.provider === provider) return config.model
  return provider === 'openai-compat' ? null : defaultModels[provider]
}

/** Resolves custom endpoint flag against provider-scoped saved config. */
const resolveBaseUrl = (flags: Flags, provider: ModelProvider, config: CliConfig | null): string | undefined => {
  if (flags.baseUrl !== undefined) return flags.baseUrl
  return config?.provider === provider ? config.baseUrl : undefined
}

/** Fully-resolved harness fields, or an error when no model can be resolved. */
type AgentFlagsResult =
  | { readonly ok: true; readonly base: ReturnType<typeof buildAgentFlags> }
  | { readonly ok: false; readonly message: string }

const buildAgentFlags = (
  flags: Flags,
  dependencies: ResolvedDependencies,
  provider: ModelProvider,
  model: string,
  baseUrl: string | undefined,
) => ({
  model,
  cwd: dependencies.cwd,
  yolo: flags.yolo,
  thinking: flags.thinking,
  provider,
  baseUrl,
  apiKey: resolveApiKey(provider, flags.apiKey, baseUrl, dependencies),
})

/** Resolves harness fields after argv scanning preserves explicit flags. */
const resolveAgentFlags = (flags: Flags, dependencies: ResolvedDependencies): AgentFlagsResult => {
  const provider = resolveProvider(flags, dependencies.config)
  const baseUrl = resolveBaseUrl(flags, provider, dependencies.config)
  const model = resolveModelId(flags, provider, dependencies.config)
  if (model === null) {
    return {
      ok: false,
      message:
        'thunderbolt: --model is required with --provider openai-compat (or save one with `thunderbolt config`)',
    }
  }
  return { ok: true, base: buildAgentFlags(flags, dependencies, provider, model, baseUrl) }
}

/**
 * Parses an `acp serve` invocation: run the built-in agent as a stdio ACP
 * server. Reuses the run-flag scanner (`--model`/`--provider`/`--base-url`/
 * `--api-key`/`--thinking`/`--yolo`); `cwd` captures trusted launch directory
 * that scopes every ACP session. Client-supplied cwd values are ignored. No
 * positional prompt is accepted.
 */
const parseServeArgs = (rest: string[], dependencies: ResolvedDependencies): ParsedArgs => {
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help' }

  const scan = scanTokens(rest, 0, defaultFlags)
  if (!scan.ok) return { kind: 'error', message: scan.message }
  if (scan.flags.positionals.length > 0) {
    return { kind: 'error', message: `thunderbolt acp serve: unexpected argument '${scan.flags.positionals[0]}'` }
  }

  const resolved = resolveAgentFlags(scan.flags, dependencies)
  if (!resolved.ok) return { kind: 'error', message: resolved.message }
  const config: ServeConfig = resolved.base
  return { kind: 'acp-serve', config }
}

/**
 * Parses a `thunderbolt login` invocation. Takes no positional arguments — the
 * device-authorization flow is fully interactive (or driven headlessly by the
 * `THUNDERBOLT_TOKEN` PAT), so anything extra is a usage error.
 */
const parseLoginArgs = (rest: string[]): ParsedArgs => {
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help' }
  if (rest.length > 0) return { kind: 'error', message: `thunderbolt login: unexpected argument '${rest[0]}'` }
  return { kind: 'login' }
}

/**
 * Parses a `thunderbolt iroh` admin invocation into its sub-action
 * (`id` | `pair` | `allow <nodeid>`).
 */
const parseIrohAdminArgs = (rest: string[]): ParsedArgs => {
  const action = rest[0]
  if (action === undefined || action === '--help' || action === '-h') return { kind: 'help' }
  if (action === 'id') return { kind: 'iroh-admin', action: { kind: 'id' } }
  if (action === 'pair') return { kind: 'iroh-admin', action: { kind: 'pair' } }
  if (action === 'allow') {
    const nodeId = rest[1]
    if (nodeId === undefined) return { kind: 'error', message: 'thunderbolt iroh allow: missing <nodeid>' }
    return { kind: 'iroh-admin', action: { kind: 'allow', nodeId } }
  }
  return {
    kind: 'error',
    message: `thunderbolt iroh: unknown action '${action}' (expected: id | pair | allow <nodeid>)`,
  }
}

/**
 * Parses CLI arguments (already stripped of runtime/script — pass
 * `Bun.argv.slice(2)`) into a {@link ParsedArgs}. Pure: no I/O, no exits.
 *
 * @param argv - the raw argument tokens
 * @returns a terminal info action (`help`/`version`/`error`), a `run` with a
 *   fully-resolved {@link RunConfig}, or a `bridge` with a {@link BridgeConfig}
 */
export const parseArgs = (argv: string[], injected: ParseArgsDependencies = {}): ParsedArgs => {
  const subcommand = argv[0]
  if (subcommand === 'login') return parseLoginArgs(argv.slice(1))
  const dependencies = resolveDependencies(injected)
  if (subcommand === 'config') {
    const argument = argv[1]
    if (argument === undefined) return { kind: 'config' }
    if (argument === '--help' || argument === '-h') return { kind: 'help' }
    return { kind: 'error', message: `thunderbolt config: unexpected argument '${argument}'` }
  }
  if (subcommand === 'iroh') return parseIrohAdminArgs(argv.slice(1))
  if (subcommand === 'acp' || subcommand === 'mcp') {
    if (subcommand === 'acp' && argv[1] === 'serve') return parseServeArgs(argv.slice(2), dependencies)
    if (argv[1] === 'connect') return parseConnectArgs(subcommand, argv.slice(2))
    return parseBridgeArgs(subcommand, argv.slice(1))
  }

  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' }
  if (argv.includes('--version') || argv.includes('-v')) return { kind: 'version' }

  const tokens = subcommand === 'agent' ? argv.slice(1) : argv
  const scan = scanTokens(tokens, 0, defaultFlags)
  if (!scan.ok) return { kind: 'error', message: scan.message }

  const prompt = scan.flags.positionals.join(' ')
  const resolved = resolveAgentFlags(scan.flags, dependencies)
  if (!resolved.ok) return { kind: 'error', message: resolved.message }
  const config: RunConfig =
    prompt.length > 0
      ? { ...resolved.base, mode: 'oneshot', prompt }
      : { ...resolved.base, mode: 'repl', noTui: scan.flags.noTui }
  return { kind: 'run', config }
}
