/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { defaultModelOpus5, type SharedModel } from '../../../shared/defaults/models.ts'
import { bundledManagedCatalog } from './catalog.ts'
import { createProviderStageContext } from './provider-stage.ts'
import { createProviderRuntime, type ProviderRuntimeDependencies } from './runtime.ts'
import { noopBindingLifecycle } from './types.ts'
import type { CliAuth, ManagedCatalog, PreparedPiBinding, ResolvedAccountCredential } from './types.ts'

const futureDirectModelId = '019f0000-0000-7000-8000-000000000001'

export const futureDirectModel: SharedModel = {
  ...defaultModelOpus5,
  id: futureDirectModelId,
  model: 'future-direct-fixture',
  name: 'Future Direct Fixture',
  description: 'Test-only future direct managed model',
}

export const futureDirectCatalog: ManagedCatalog = {
  version: 1,
  defaultModelId: futureDirectModelId,
  data: [futureDirectModel],
}

/** Creates a valid stored-session credential for provider-runtime tests. */
export const testSessionCredential = (
  overrides: Partial<Extract<ResolvedAccountCredential, { type: 'session' }>> = {},
): Extract<ResolvedAccountCredential, { type: 'session' }> => ({
  type: 'session',
  backendUrl: 'https://api.example.com/v1',
  bearer: 'stored-session',
  deviceId: 'cli-00000000-0000-7000-8000-000000000001',
  userCacheSecret: new Uint8Array(32).fill(7),
  ...overrides,
})

const createTestBinding = (
  providerId: string,
  modelId: string,
  persistsCredentialStatus = false,
): PreparedPiBinding => ({
  providerId,
  wireModel: modelId,
  persistsCredentialStatus,
  piModel: { provider: providerId, id: modelId } as Model<Api>,
  install: () => {},
  ...noopBindingLifecycle,
})

/** Creates a successful OpenAI-compatible streaming completion response. */
export const successfulCompletion = (model: string): Response =>
  new Response(
    [
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'future model' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

/** Creates a failed OpenAI-compatible completion response. */
export const failedCompletion = (status: number): Response =>
  Response.json({ error: { message: `direct failure ${status}`, type: 'test_error' } }, { status })

/** Installs and executes a prepared binding through Pi's model registry. */
export const runBinding = async (binding: PreparedPiBinding): Promise<AssistantMessage> => {
  const models = createModels()
  binding.install(models)
  return models.completeSimple(
    binding.piModel,
    { messages: [{ role: 'user', content: 'test prompt', timestamp: 1 }] },
    { reasoning: 'high' },
  )
}

/** Builds a provider runtime with production-shaped test dependencies.
 * Individual dependencies can be overridden for focused scenarios. */
export const createTestProviderRuntime = async (overrides: Partial<ProviderRuntimeDependencies> = {}) => {
  const session = testSessionCredential()
  const auth: CliAuth = {
    version: 2,
    backendUrl: session.backendUrl,
    deviceId: session.deviceId,
    userCacheSecret: Buffer.from(session.userCacheSecret).toString('hex'),
    registration: 'registered',
    bearer: session.bearer,
  }
  const dependencies: ProviderRuntimeDependencies = {
    loadConfig: async () => null,
    saveConfig: async () => {},
    resolveAccountCredential: async () => null,
    loadAuthConfig: async () => null,
    accountActions: { login: async () => auth, logout: async () => 'logged-out' },
    loadCatalog: async () => bundledManagedCatalog,
    ensureRegisteredSession: async (credential) => credential,
    markSessionAuthenticationRequired: async () => {},
    metadata: { deviceName: 'Test CLI' },
    createByokBinding: async (profile, selection) =>
      createTestBinding(profile.id, selection.model ?? profile.defaultModel, true),
    createManagedDirectBinding: async ({ model }) => createTestBinding('thunderbolt', model.model),
    createTinfoilBinding: async ({ model }) => createTestBinding('thunderbolt', model.model),
    environment: {},
    providerStage: createProviderStageContext(),
    ...overrides,
  }
  return { dependencies, runtime: await createProviderRuntime(dependencies) }
}
