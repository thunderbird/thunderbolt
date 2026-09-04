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

import type { SkillDefinition } from '../../../shared/agent-core/skills.ts'
import type { InvocationSelection } from '../provider-runtime/types.ts'

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

/** Whether a provider ID names one of Pi's built-in providers. */
export const isBuiltinProvider = (value: string): value is BuiltinProvider =>
  (builtinProviders as readonly string[]).includes(value)

/** Built-in Pi provider exposed by thunderbolt. */
export type BuiltinProvider = (typeof builtinProviders)[number]

/** Model backend selected for a harness. */
export type ModelProvider = BuiltinProvider | 'openai-compat'

/** Wire protocol whose local stdio process the bridge exposes over the network.
 *  Drives only logging — the stdio↔transport pump is byte-identical for both. */
export type BridgeProtocol = 'acp' | 'mcp'

/** Network transport a bridge exposes its stdio process over. `wss` is a
 *  loopback-only WebSocket; `iroh` is the authenticated P2P/E2E transport. */
export type BridgeTransport = 'wss' | 'iroh'

/**
 * Fully-resolved configuration for an `acp`/`mcp` bridge invocation, produced by
 * {@link parseCommandSyntax} and consumed by the bridge runner.
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
 * (oneshot run, REPL, and the ACP server's per-session harness).
 */
export type HarnessConfig = {
  /** Working directory the agent's bash/fs tools are bound to. */
  readonly cwd: string
  /** Trusted filesystem root for ACP path-tool confinement. Omitted by local CLI modes. */
  readonly workspaceRoot?: string
  /** Reasoning depth for the harness. */
  readonly thinking: ThinkingLevel
  /** When true, the system prompt names the underlying model so an exposed ACP
   *  agent can self-identify. The standalone CLI leaves this off. */
  readonly announceModel?: boolean
  /** Skill definitions delivered by ACP session metadata. */
  readonly skills?: readonly SkillDefinition[]
}

type CommandExecutionConfig = Pick<HarnessConfig, 'cwd' | 'thinking'> & {
  readonly yolo: boolean
  readonly selection: InvocationSelection
}

/** Canonical syntactic configuration for an `acp serve` invocation. */
export type CommandSyntaxServeConfig = CommandExecutionConfig

/** Canonical syntactic configuration for a direct CLI invocation. */
export type CommandSyntaxRunConfig = CommandExecutionConfig &
  { readonly fullscreen: boolean } &
  ({ readonly mode: 'oneshot'; readonly prompt: string } | { readonly mode: 'repl'; readonly noTui: boolean })

/** Canonical result of syntactically parsing command-line arguments. */
export type ParsedCommandSyntax =
  | { readonly kind: 'run'; readonly config: CommandSyntaxRunConfig }
  | { readonly kind: 'config' }
  | { readonly kind: 'bridge'; readonly config: BridgeConfig }
  | { readonly kind: 'connect'; readonly config: ConnectConfig }
  | { readonly kind: 'acp-serve'; readonly config: CommandSyntaxServeConfig }
  | { readonly kind: 'iroh-admin'; readonly action: IrohAdminAction }
  | { readonly kind: 'login' }
  | { readonly kind: 'logout' }
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
