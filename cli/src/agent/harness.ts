/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Assembles the Pi `AgentHarness` — the spine that lets the CLI actually talk
 * to Claude. It binds a Node execution environment (real bash + filesystem) to
 * the working directory, opens an in-memory session, resolves the model, and
 * registers the four coding tools (bash/read/write/edit).
 */

import { AgentHarness, InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent'
import { resolveModel } from './model.ts'
import { buildSystemPrompt } from './system-prompt.ts'
import type { HarnessBundle, HarnessConfig } from './types.ts'

/**
 * Builds a ready-to-run harness for a single CLI invocation, paired with a
 * `dispose` that releases the execution environment. Renderer and permission
 * hooks are attached by the caller, not here.
 *
 * @param config - the resolved harness configuration
 * @returns the constructed harness and its teardown function
 */
export const buildHarness = async (config: HarnessConfig): Promise<HarnessBundle> => {
  const env = new NodeExecutionEnv({ cwd: config.cwd })
  const session = await new InMemorySessionRepo().create({})
  const { models, model } = resolveModel({
    model: config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  })
  const tools = [
    createBashTool(config.cwd),
    createReadTool(config.cwd),
    createWriteTool(config.cwd),
    createEditTool(config.cwd),
  ]

  const harness = new AgentHarness({
    env,
    session,
    models,
    model,
    tools,
    activeToolNames: tools.map((tool) => tool.name),
    thinkingLevel: config.thinking,
    systemPrompt: buildSystemPrompt({ cwd: config.cwd, modelId: config.announceModel ? config.model : undefined }),
  })

  return {
    harness,
    dispose: async () => {
      await env.cleanup()
    },
  }
}
