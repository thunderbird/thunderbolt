/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Assembles a Pi {@link AgentHarness} for the APP — the in-browser analogue of
 * the CLI's `buildHarness`. Where the CLI binds a `NodeExecutionEnv` (real bash +
 * `node:fs`) and lets Pi's anthropic provider read `ANTHROPIC_API_KEY`, the app
 * harness runs entirely inside the browser:
 *
 *   - the model is Pi's anthropic model wired through the caller's injected
 *     `fetch` (the app's CORS proxy) via {@link buildAnthropicModel};
 *   - the execution environment is a {@link BrowserExecutionEnv} over an
 *     OPFS-backed ZenFS mount ({@link mountAgentFs}), with an in-memory fallback;
 *   - the four coding tools (bash/read/write/edit) are bound to that same mount
 *     via {@link createBrowserCodingTools} — plain Pi `AgentTool`s over the
 *     {@link BrowserExecutionEnv}, with no `@earendil-works/pi-coding-agent` (and
 *     hence no Node child-process/`undici`/TUI) cascade on the app path.
 *
 * Extra `tools` (e.g. the app's MCP tools converted via `./mcp-tools.ts`) are
 * appended and made active alongside the coding tools.
 */

import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentHarnessOptions,
  type AgentTool,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import { buildAnthropicModel, type AgentFetch } from './anthropic-model.ts'
import { buildOpenAiCompatModel } from './openai-compat-model.ts'
import { BrowserExecutionEnv } from './browser-env/browser-execution-env.ts'
import { mountAgentFs } from './browser-env/mount.ts'
import { createBrowserCodingTools } from './coding-tools/index.ts'
import { ensureBufferPolyfill } from './ensure-buffer.ts'
import { buildSeedMessages, type SeedTurn } from './seed-history.ts'

/** Mount-relative root under which every thread carves its isolated workspace. */
const WORKSPACE_ROOT = '/workspace'

/**
 * Absolute mount-relative workspace directory for a thread. Each thread gets its
 * own subtree under {@link WORKSPACE_ROOT} so concurrent threads never see each
 * other's files even though they share the one process-global ZenFS mount.
 *
 * @param threadId - the chat thread id (an app-generated id, e.g. a UUID)
 * @returns the thread's absolute workspace directory, e.g. `/workspace/<threadId>`
 */
export const workspaceDirFor = (threadId: string): string => {
  // The workspace dir is also the jail boundary for every coding tool, so a
  // threadId containing `/` or `..` would move the boundary and defeat the jail.
  // App thread ids are UUID-shaped; reject anything else loudly rather than
  // silently weakening isolation.
  if (!/^[A-Za-z0-9._-]+$/.test(threadId) || threadId === '.' || threadId === '..') {
    throw new Error(`unsafe threadId for workspace: ${threadId}`)
  }
  return `${WORKSPACE_ROOT}/${threadId}`
}

/**
 * The model the harness runs, tagged by Pi engine family. Both variants route
 * their LLM HTTP through an injected `fetch` (the app's proxy / SSO fetch):
 *
 *   - `anthropic` resolves a model from Pi's built-in catalog and wires the
 *     `@anthropic-ai/sdk` client through `fetch` ({@link buildAnthropicModel}).
 *   - `openai-compat` synthesizes an `openai-completions` model for the app's
 *     OpenAI-wire providers (`openai`/`custom`/`openrouter`/`thunderbolt`) and
 *     injects `fetch` around client construction ({@link buildOpenAiCompatModel}).
 */
export type PiModelDescriptor =
  | {
      readonly kind: 'anthropic'
      /** Anthropic model id to resolve from Pi's catalog, e.g. `claude-opus-4-8`. */
      readonly modelId: string
      /** Anthropic API key (HTTP still flows through `fetch`). */
      readonly apiKey: string
      /** Fetch every request is routed through — the app's proxy fetch. */
      readonly fetch: AgentFetch
    }
  | {
      readonly kind: 'openai-compat'
      /** App provider name, also used as the Pi provider id. */
      readonly providerId: string
      /** Upstream model id sent on the wire. */
      readonly modelId: string
      /** OpenAI-compatible base URL. */
      readonly baseURL: string
      /** Bearer key for the OpenAI SDK (placeholder when `fetch` supplies auth). */
      readonly apiKey: string
      /** Provider-specific app fetch (proxy fetch, or thunderbolt SSO fetch). */
      readonly fetch: AgentFetch
      /** Whether to request a reasoning effort (else Pi sends none). */
      readonly reasoning: boolean
      /** Optional upstream context window. */
      readonly contextWindow?: number
    }

/** Inputs for {@link buildAppHarness}. */
export type BuildAppHarnessOptions = {
  /** The model to run, tagged by Pi engine family. */
  readonly model: PiModelDescriptor
  /** System prompt sent with each model request. */
  readonly systemPrompt: AgentHarnessOptions['systemPrompt']
  /** Reasoning depth for the harness. */
  readonly thinkingLevel: ThinkingLevel
  /** Chat thread this harness serves. Its tools are bound to the thread's
   *  isolated workspace ({@link workspaceDirFor}). */
  readonly threadId: string
  /** Extra tools to register and activate alongside the four coding tools. */
  readonly tools?: AgentTool[]
  /** Prior conversation turns to seed into the session before the first prompt,
   *  so the agent has multi-turn context. Omitted/empty starts a blank session. */
  readonly history?: readonly SeedTurn[]
}

/**
 * Build a ready-to-run app harness for a thread. Mounts the ZenFS singleton
 * (once), carves the thread's isolated workspace under {@link WORKSPACE_ROOT},
 * binds the coding tools to it, resolves the proxied model (anthropic or
 * openai-compatible), and returns the constructed harness. The workspace persists
 * with the harness; tear it down by removing {@link workspaceDirFor}`(threadId)`
 * when the thread is disposed.
 *
 * @param options - model descriptor, prompt, thinking level, thread id, extra tools, history
 * @returns the constructed {@link AgentHarness}
 */
export const buildAppHarness = async (options: BuildAppHarnessOptions): Promise<AgentHarness> => {
  ensureBufferPolyfill()
  await mountAgentFs()
  const workspaceDir = workspaceDirFor(options.threadId)
  const env = new BrowserExecutionEnv({ cwd: workspaceDir })
  const created = await env.createDir(workspaceDir)
  if (!created.ok) {
    throw created.error
  }
  const session = await new InMemorySessionRepo().create({})
  const { models, model } =
    options.model.kind === 'anthropic'
      ? buildAnthropicModel({
          apiKey: options.model.apiKey,
          fetch: options.model.fetch,
          modelId: options.model.modelId,
        })
      : buildOpenAiCompatModel({
          providerId: options.model.providerId,
          modelId: options.model.modelId,
          baseURL: options.model.baseURL,
          apiKey: options.model.apiKey,
          fetch: options.model.fetch,
          reasoning: options.model.reasoning,
          contextWindow: options.model.contextWindow,
        })

  const tools: AgentTool[] = [...createBrowserCodingTools(env, { cwd: workspaceDir }), ...(options.tools ?? [])]

  const harness = new AgentHarness({
    env,
    session,
    models,
    model,
    tools,
    activeToolNames: tools.map((tool) => tool.name),
    thinkingLevel: options.thinkingLevel,
    systemPrompt: options.systemPrompt,
  })

  // Seed prior turns into the (idle) session so the first prompt runs with full
  // conversational context. `appendMessage` writes straight to the session while
  // idle; `prompt` then reads them back via `session.buildContext()`.
  for (const message of buildSeedMessages(options.history)) {
    await harness.appendMessage(message)
  }

  return harness
}
