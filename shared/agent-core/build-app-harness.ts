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
 *     through {@link createBashOperations} and the file-operation adapters.
 *
 * Extra `tools` (e.g. the app's MCP tools converted via `./mcp-tools.ts`) are
 * appended and made active alongside the coding tools.
 */

import { AgentHarness, InMemorySessionRepo, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent'
import { buildAnthropicModel, type AgentFetch } from './anthropic-model.ts'
import { BrowserExecutionEnv } from './browser-env/browser-execution-env.ts'
import {
  createBashOperations,
  createEditOperations,
  createReadOperations,
  createWriteOperations,
} from './browser-env/coding-tool-operations.ts'
import { mountAgentFs } from './browser-env/mount.ts'
import { ensureBufferPolyfill } from './ensure-buffer.ts'
import { buildSeedMessages, type SeedTurn } from './seed-history.ts'

/** Absolute mount-relative directory the agent's tools are bound to. */
const AGENT_CWD = '/workspace'

/** Inputs for {@link buildAppHarness}. */
export type BuildAppHarnessOptions = {
  /** Anthropic API key (HTTP still flows through `fetch`). */
  readonly apiKey: string
  /** Fetch every request is routed through — the app passes its proxy fetch. */
  readonly fetch: AgentFetch
  /** Anthropic model id to run, e.g. `claude-opus-4-8`. */
  readonly modelId: string
  /** System prompt sent with each model request. */
  readonly systemPrompt: string
  /** Reasoning depth for the harness. */
  readonly thinkingLevel: ThinkingLevel
  /** Extra tools to register and activate alongside the four coding tools. */
  readonly tools?: AgentTool[]
  /** Prior conversation turns to seed into the session before the first prompt,
   *  so the agent has multi-turn context. Omitted/empty starts a blank session. */
  readonly history?: readonly SeedTurn[]
}

/**
 * Build a ready-to-run app harness. Mounts the ZenFS singleton (once), binds the
 * coding tools to it, resolves the proxied anthropic model, and returns the
 * constructed harness. No teardown is needed — {@link BrowserExecutionEnv} owns
 * no per-instance resources (ZenFS is a process-global singleton).
 *
 * @param options - api key, injected fetch, model id, prompt, thinking level, extra tools
 * @returns the constructed {@link AgentHarness}
 */
export const buildAppHarness = async (options: BuildAppHarnessOptions): Promise<AgentHarness> => {
  ensureBufferPolyfill()
  await mountAgentFs()
  const env = new BrowserExecutionEnv({ cwd: AGENT_CWD })
  const created = await env.createDir(AGENT_CWD)
  if (!created.ok) {
    throw created.error
  }
  const session = await new InMemorySessionRepo().create({})
  const { models, model } = buildAnthropicModel({
    apiKey: options.apiKey,
    fetch: options.fetch,
    modelId: options.modelId,
  })

  const tools: AgentTool[] = [
    createBashTool(AGENT_CWD, { operations: createBashOperations(env) }),
    createReadTool(AGENT_CWD, { operations: createReadOperations() }),
    createWriteTool(AGENT_CWD, { operations: createWriteOperations() }),
    createEditTool(AGENT_CWD, { operations: createEditOperations() }),
    ...(options.tools ?? []),
  ]

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
