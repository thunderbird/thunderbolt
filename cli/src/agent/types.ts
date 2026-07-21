/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared module contracts for the thunderbolt CLI.
 *
 * These types are the stable seam between the CLI's modules (arg parsing,
 * harness assembly, the streaming renderer, and the permission gate) so each
 * can be built and reasoned about independently. Pi types (e.g. `AgentHarness`)
 * are imported directly from `@earendil-works/pi-agent-core` where needed.
 */

import type { AgentHarness } from '@earendil-works/pi-agent-core'

/**
 * A constructed harness paired with a teardown function. `buildHarness`
 * returns this so callers release the underlying execution environment
 * (temp dirs, shell) without reaching into Pi internals.
 */
export type HarnessBundle = {
  readonly harness: AgentHarness
  readonly dispose: () => Promise<void>
}

/** Reasoning depth passed to the Pi harness (`thinkingLevel`). */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Built-in Pi providers exposed by thunderbolt. */
export const builtinProviders = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'zai',
  'mistral',
  'groq',
  'openrouter',
  'moonshotai',
  'minimax',
  'cerebras',
  'together',
  'fireworks',
] as const

/** Built-in Pi provider exposed by thunderbolt. */
export type BuiltinProvider = (typeof builtinProviders)[number]

/** All model backends accepted by `--provider`. */
export const modelProviders = [...builtinProviders, 'openai-compat'] as const

/** Model backend selected for a harness. */
export type ModelProvider = (typeof modelProviders)[number]

/** Narrows an unknown value to a supported {@link ModelProvider}. */
export const isProvider = (value: unknown): value is ModelProvider =>
  typeof value === 'string' && (modelProviders as readonly string[]).includes(value)

/** Wire protocol whose local stdio process the bridge exposes over the network.
 *  Drives only logging — the stdio↔transport pump is byte-identical for both. */
export type BridgeProtocol = 'acp' | 'mcp'

/** Network transport a bridge exposes its stdio process over. `wss` is a
 *  loopback-only WebSocket; `iroh` is the authenticated P2P/E2E transport. */
export type BridgeTransport = 'wss' | 'iroh'

/**
 * Fully-resolved configuration for an `acp`/`mcp` bridge invocation, produced by
 * {@link parseArgs} and consumed by the bridge runner.
 */
export type BridgeConfig = {
  /** Which protocol's stdio process is being bridged. */
  readonly protocol: BridgeProtocol
  /** Network transport exposing the process. */
  readonly transport: BridgeTransport
  /** TCP port the WebSocket server listens on (`wss` only; ignored by `iroh`). */
  readonly port: number
  /** The spawned stdio agent command: `command[0]` is the executable. */
  readonly command: readonly string[]
}

/**
 * Configuration for an `acp`/`mcp connect` invocation: dial a remote iroh bridge
 * and pump a local client into it.
 */
export type ConnectConfig = {
  /** Which protocol the local client speaks (drives only logging). */
  readonly protocol: BridgeProtocol
  /** The remote bridge to dial: a connection ticket or a bare NodeId. */
  readonly target: string
  /** Optional local stdio client to spawn; empty means bridge this process's
   *  own stdin/stdout (so a JSON-RPC line can be piped through). */
  readonly command: readonly string[]
}

/** A `thunderbolt iroh` admin action: inspect identity, mint a pairing ticket,
 *  or extend the peer allowlist. */
export type IrohAdminAction =
  | { readonly kind: 'id' }
  | { readonly kind: 'pair' }
  | { readonly kind: 'allow'; readonly nodeId: string }

/**
 * Settings a single harness needs to be assembled, shared by every entry point
 * (oneshot run, REPL, and the ACP server's per-session harness). `buildHarness`
 * consumes exactly this; the run/serve configs extend it with their own fields.
 */
export type HarnessConfig = {
  /** Pi catalog model id for built-in providers, or upstream model id for
   *  `openai-compat`. */
  readonly model: string
  /** Working directory the agent's bash/fs tools are bound to. */
  readonly cwd: string
  /** Trusted filesystem root for ACP path-tool confinement. Omitted by local CLI modes. */
  readonly workspaceRoot?: string
  /** When true, auto-approve every tool call (no interactive gate). */
  readonly yolo: boolean
  /** Reasoning depth for the harness. */
  readonly thinking: ThinkingLevel
  /** Model backend to use (defaults to `anthropic`). */
  readonly provider?: ModelProvider
  /** OpenAI-compatible base URL — required when `provider` is `openai-compat`. */
  readonly baseUrl?: string
  /** Explicit provider api key. Built-in providers otherwise resolve their own
   *  environment variable; openai-compat uses its dedicated CLI env fallback. */
  readonly apiKey?: string
  /** When true, the system prompt names the underlying model so an exposed ACP
   *  agent can self-identify. The standalone CLI leaves this off. */
  readonly announceModel?: boolean
}

/**
 * Configuration for an `acp serve` invocation: run THIS coding agent as a stdio
 * ACP JSON-RPC server. `cwd` is trusted launch directory and cannot be overridden
 * by client session requests.
 */
export type ServeConfig = HarnessConfig

/**
 * Fully-resolved configuration for a single CLI invocation, produced by
 * {@link parseArgs} and consumed by the agent runner. The discriminated `mode`
 * makes `prompt` present exactly when (and only when) it's a oneshot run.
 */
export type RunConfig =
  | (HarnessConfig & { readonly mode: 'oneshot'; readonly prompt: string })
  | (HarnessConfig & {
      readonly mode: 'repl'
      /** Force the plain readline REPL, never the interactive TUI (`--no-tui`).
       *  The TUI is otherwise the default when stdout is a TTY. */
      readonly noTui: boolean
    })

/** Result of parsing argv: a run, config setup, bridge, connect, ACP server,
 *  iroh admin action, login, or terminal info action. */
export type ParsedArgs =
  | { readonly kind: 'run'; readonly config: RunConfig }
  | { readonly kind: 'config' }
  | { readonly kind: 'bridge'; readonly config: BridgeConfig }
  | { readonly kind: 'connect'; readonly config: ConnectConfig }
  | { readonly kind: 'acp-serve'; readonly config: ServeConfig }
  | { readonly kind: 'iroh-admin'; readonly action: IrohAdminAction }
  | { readonly kind: 'login' }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string }

/** User's answer when asked to approve a tool call. */
export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'

/** A request surfaced to the user before a gated tool call runs. */
export type PermissionRequest = {
  /** Tool being invoked, e.g. `bash`, `write`, `edit`. */
  readonly toolName: string
  /** One-line human summary, e.g. the bash command or target path. */
  readonly summary: string
  /** Optional multi-line detail (diff, full command, etc.). */
  readonly detail?: string
}

/** Asks the user to approve a gated tool call. Injected into the gate. */
export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionDecision>

/**
 * Interactive terminal I/O over a single shared readline interface — used both
 * for the REPL input loop and for permission prompts so they don't fight over
 * stdin.
 */
export type TerminalIO = {
  /** Read one line of input for the given prompt label; `null` at EOF (Ctrl-D). */
  readonly readLine: (prompt: string) => Promise<string | null>
  /** Ask the user to approve a tool call. */
  readonly ask: PermissionPrompt
  /** Tear down the readline interface. */
  readonly close: () => void
}
