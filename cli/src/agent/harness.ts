/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Assembles the Pi `AgentHarness` — the spine that lets the CLI talk to the
 * selected model provider. It binds a Node execution environment (real bash +
 * filesystem) to the working directory, opens an in-memory session, resolves
 * the model, and registers coding tools. Workspace-root harnesses omit bash
 * because arbitrary shell commands cannot be confined to that workspace.
 */

import { AgentHarness, InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import type { Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent'
import { resolveModel } from './model.ts'
import { buildSystemPrompt } from './system-prompt.ts'
import type { HarnessBundle, HarnessConfig } from './types.ts'
import { createWorkspaceTools } from './workspace-jail.ts'

/**
 * Builds a ready-to-run harness for a single CLI invocation, paired with a
 * `dispose` that releases the execution environment. Renderer and permission
 * hooks are attached by the caller, not here.
 *
 * When `session` is supplied (the ACP server's new/resume paths), the harness
 * folds its persisted entry log into every turn via `session.buildContext()`, so
 * a disk-opened session rehydrates the full prior conversation with no other
 * change here. Omitting it (the one-shot / REPL CLI) keeps the ephemeral
 * in-memory session. Note the harness's model/thinking/active-tools come from
 * `config`, not the recorded session — a resumed thread runs under the
 * connection's current config, which the app keeps consistent per thread.
 *
 * @param config - the resolved harness configuration
 * @param session - an existing session to resume; defaults to a fresh in-memory one
 * @returns the constructed harness and its teardown function
 */
export const buildHarness = async (config: HarnessConfig, session?: Session): Promise<HarnessBundle> => {
  const env = new NodeExecutionEnv({ cwd: config.cwd })
  const activeSession = session ?? (await new InMemorySessionRepo().create({}))
  const { models, model } = resolveModel({
    model: config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  })
  const tools = config.workspaceRoot
    ? createWorkspaceTools(config.workspaceRoot)
    : [createBashTool(config.cwd), createReadTool(config.cwd), createWriteTool(config.cwd), createEditTool(config.cwd)]

  const harness = new AgentHarness({
    env,
    session: activeSession,
    models,
    model,
    tools,
    activeToolNames: tools.map((tool) => tool.name),
    thinkingLevel: config.thinking,
    systemPrompt: buildSystemPrompt({
      cwd: config.cwd,
      modelId: config.announceModel ? config.model : undefined,
      bashEnabled: tools.some((tool) => tool.name === 'bash'),
    }),
  })

  return {
    harness,
    dispose: async () => {
      await env.cleanup()
    },
  }
}
