/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The app's in-browser agent engine: a Pi {@link AgentHarness} assembled over an
 * OPFS-backed ZenFS execution environment, with the Anthropic model routed
 * through the app's proxy fetch and the app's MCP tools bridged in.
 */

// Side-effect import — MUST stay first. Installs the Node globals Pi reads at
// module scope (`process`, `global`) before any Pi module evaluates; otherwise the
// browser throws `ReferenceError: process is not defined`. See ./browser-stubs/install-process.ts.
import './browser-stubs/install-process.ts'

export {
  buildAnthropicModel,
  isKnownAnthropicModel,
  type AgentFetch,
  type BuildAnthropicModelOptions,
} from './anthropic-model.ts'
export { buildOpenAiCompatModel, type BuildOpenAiCompatModelOptions } from './openai-compat-model.ts'
export {
  buildAppHarness,
  workspaceDirFor,
  type BuildAppHarnessOptions,
  type PiModelDescriptor,
} from './build-app-harness.ts'
export { ensureBufferPolyfill } from './ensure-buffer.ts'
export { APP_HARNESS_ENVIRONMENT_PROMPT } from './environment-prompt.ts'
export { toPiAgentTools } from './mcp-tools.ts'
export type { SeedTurn } from './seed-history.ts'
export { piHarnessToUiMessageStream, type AiSdkChunk, type PiStreamMetadata } from './pi-to-aisdk-stream.ts'
export { BrowserExecutionEnv, mountAgentFs, mountInMemoryFs, type MountedBackend } from './browser-env/index.ts'
