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

import { AgentHarness, InMemorySessionRepo, toError } from '@earendil-works/pi-agent-core'
import type { AgentTool, Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { createModels } from '@earendil-works/pi-ai'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent'
import { createPiHarnessRuntime, installPreparedBinding } from '../provider-runtime/harness-runtime.ts'
import type { HarnessRuntime, PreparedPiBinding } from '../provider-runtime/types.ts'
import { cleanupFailure, collectCleanupErrors } from './cleanup-errors.ts'
import { configureNativeWebSearch } from './model.ts'
import { createSkillTool } from './skill-tool.ts'
import { buildSystemPrompt } from './system-prompt.ts'
import type { HarnessConfig } from './types.ts'
import { createWorkspaceTools } from './workspace-jail.ts'
import { createWebFetchTool } from './webfetch.ts'

/** Build complete toolset shared by local CLI and ACP-served harnesses. */
export const createHarnessTools = (config: Pick<HarnessConfig, 'cwd' | 'workspaceRoot' | 'skills'>): AgentTool[] => {
  const codingTools = config.workspaceRoot
    ? createWorkspaceTools(config.workspaceRoot)
    : [createBashTool(config.cwd), createReadTool(config.cwd), createWriteTool(config.cwd), createEditTool(config.cwd)]
  const skillTools = config.skills?.length ? [createSkillTool(config.skills)] : []
  return [...codingTools, createWebFetchTool(), ...skillTools]
}

/** Build the sole live runtime from a prepared provider binding. */
export const createHarnessRuntime = async (
  config: HarnessConfig,
  binding: PreparedPiBinding,
  session?: Session,
): Promise<HarnessRuntime> => {
  const env = new NodeExecutionEnv({ cwd: config.cwd })
  try {
    const activeSession = session ?? (await new InMemorySessionRepo().create({}))
    const models = createModels()
    installPreparedBinding(models, binding)
    const tools = createHarnessTools(config)
    const harness = new AgentHarness({
      env,
      session: activeSession,
      models,
      model: binding.piModel,
      tools,
      activeToolNames: tools.map((tool) => tool.name),
      thinkingLevel: config.thinking,
      systemPrompt: buildSystemPrompt({
        cwd: config.cwd,
        modelId: config.announceModel ? binding.wireModel : undefined,
        bashEnabled: tools.some((tool) => tool.name === 'bash'),
        skills: config.skills,
      }),
    })
    const unsubscribeWebSearch = harness.on('before_provider_payload', ({ model: requestModel, payload }) => ({
      payload: configureNativeWebSearch(requestModel, payload),
    }))
    return await createPiHarnessRuntime({
      harness,
      models,
      binding,
      cleanupHarness: async () => {
        const errors = await collectCleanupErrors([unsubscribeWebSearch, () => env.cleanup()])
        if (errors.length > 0) throw cleanupFailure('Harness cleanup failed.', errors)
      },
    })
  } catch (error) {
    const cleanupErrors = await collectCleanupErrors([() => binding.dispose(), () => env.cleanup()])
    const failure = toError(error)
    if (cleanupErrors.length > 0) throw cleanupFailure(failure.message, [failure, ...cleanupErrors])
    throw error
  }
}
