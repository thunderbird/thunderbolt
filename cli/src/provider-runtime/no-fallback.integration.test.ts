/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it, spyOn } from 'bun:test'
import { createHarnessRuntime } from '../agent/harness.ts'
import { resolveAccountCredential } from '../auth/token-store.ts'
import { createByokBinding } from './byok.ts'
import { bundledManagedCatalog, fetchManagedCatalog } from './catalog.ts'
import { createManagedDirectBinding } from './direct.ts'
import { createProviderStageContext } from './provider-stage.ts'
import type { ProviderRuntimeDependencies } from './runtime.ts'
import {
  createTestProviderRuntime,
  failedCompletion,
  futureDirectCatalog,
  runBinding,
  successfulCompletion,
} from './test-fixtures.ts'
import type { AccountFetch, CliConfig, ManagedCatalog, PreparedPiBinding } from './types.ts'

type InferenceRequestSnapshot = {
  readonly url: string
  readonly headers: Headers
  readonly body: unknown
}
type InferenceResponder = (request: InferenceRequestSnapshot) => Response | Promise<Response>

/** Execute a prepared binding through the real CLI prompt runtime and its error observer. */
const runHarnessPrompt = async (binding: PreparedPiBinding): Promise<AssistantMessage> => {
  const harness = await createHarnessRuntime({ cwd: process.cwd(), thinking: 'off' }, binding)
  try {
    return await harness.prompt('acceptance prompt')
  } finally {
    await harness.dispose()
  }
}

/** Create the real parser/runtime/direct-binding stack around one fixture catalog. */
const createPatRuntime = async (catalog: ManagedCatalog, respond: InferenceResponder) => {
  const inferenceRequests: InferenceRequestSnapshot[] = []
  const producerCalls = { byok: 0, direct: 0, confidential: 0, registration: 0 }
  const inferenceFetch: AccountFetch = async (input, init) => {
    const request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: (await new Response(init?.body).json()) as unknown,
    }
    inferenceRequests.push(request)
    return respond(request)
  }
  const catalogFetch: AccountFetch = async () =>
    Response.json({
      defaults: {
        models: {
          ...catalog,
          futureOnlyCatalogField: 'ignored',
          data: catalog.data.map((model) => ({ ...model, futureOnlyModelField: 'ignored' })),
        },
      },
    })
  const config: CliConfig = {
    version: 3,
    activeProviderId: 'thunderbolt',
    thunderbolt: { defaultModelId: catalog.defaultModelId },
    providers: [],
  }
  const dependencies: ProviderRuntimeDependencies = {
    loadConfig: async () => config,
    loadAuthConfig: async () => null,
    saveConfig: async () => {},
    resolveAccountCredential,
    accountActions: {
      login: async () => {
        throw new Error('PAT acceptance must not start web login')
      },
      logout: async () => 'pat-managed-externally',
    },
    loadCatalog: (backendUrl) => fetchManagedCatalog(backendUrl, catalogFetch),
    ensureRegisteredSession: async (credential) => {
      producerCalls.registration += 1
      return credential
    },
    markSessionAuthenticationRequired: async () => {},
    metadata: { deviceName: 'Acceptance CLI' },
    createByokBinding: async () => {
      producerCalls.byok += 1
      throw new Error('unexpected BYOK fallback')
    },
    createManagedDirectBinding: async (options) => {
      producerCalls.direct += 1
      return createManagedDirectBinding({ ...options, fetchFn: inferenceFetch })
    },
    createTinfoilBinding: async () => {
      producerCalls.confidential += 1
      throw new Error('unexpected confidential fallback')
    },
    environment: {
      THUNDERBOLT_TOKEN: 'acceptance-pat',
      THUNDERBOLT_CLOUD_URL: 'https://api.example.test/v1',
    },
    providerStage: createProviderStageContext(),
  }

  return { runtime: (await createTestProviderRuntime(dependencies)).runtime, inferenceRequests, producerCalls }
}

describe('ProviderRuntime acceptance without fallback or replay', () => {
  it('sends a fixture-only direct row through parsing, binding, and PAT dispatch', async () => {
    const futureCatalog = futureDirectCatalog
    const harness = await createPatRuntime(futureCatalog, () => successfulCompletion('future-direct-fixture'))

    const binding = await harness.runtime.prepare({
      providerId: 'thunderbolt',
      model: 'future-direct-fixture',
    })
    const result = await runBinding(binding)

    expect(result.stopReason).toBe('stop')
    expect(result.content).toContainEqual({ type: 'text', text: 'future model' })
    expect(binding).toMatchObject({
      providerId: 'thunderbolt',
      wireModel: 'future-direct-fixture',
      persistsCredentialStatus: false,
    })
    expect(harness.producerCalls).toEqual({ byok: 0, direct: 1, confidential: 0, registration: 0 })
    expect(harness.inferenceRequests).toHaveLength(1)
    expect(harness.inferenceRequests[0]?.url).toBe('https://api.example.test/v1/chat/completions')
    expect(harness.inferenceRequests[0]?.headers.get('x-api-key')).toBe('acceptance-pat')
    expect(harness.inferenceRequests[0]?.headers.has('authorization')).toBe(false)
    expect(harness.inferenceRequests[0]?.body).toMatchObject({ model: 'future-direct-fixture' })
  })

  it('rejects PAT GLM with WEB_LOGIN_REQUIRED before any producer or inference request', async () => {
    const confidentialModel = bundledManagedCatalog.data.find(({ isConfidential }) => isConfidential === 1)
    if (!confidentialModel) throw new Error('managed catalog requires a confidential acceptance model')
    const harness = await createPatRuntime(bundledManagedCatalog, () => {
      throw new Error('PAT confidential selection must not send inference')
    })

    await expect(
      harness.runtime.prepare({ providerId: 'thunderbolt', model: confidentialModel.model }),
    ).rejects.toMatchObject({
      code: 'WEB_LOGIN_REQUIRED',
    })

    expect(harness.producerCalls).toEqual({ byok: 0, direct: 0, confidential: 0, registration: 0 })
    expect(harness.inferenceRequests).toEqual([])
  })

  it.each([
    ['authentication', 401],
    ['quota', 429],
    ['provider', 503],
  ] as const)('makes one direct request after a %s failure with no replay or fallback', async (_case, status) => {
    const futureCatalog = futureDirectCatalog
    const harness = await createPatRuntime(futureCatalog, () => failedCompletion(status))
    const binding = await harness.runtime.prepare({ providerId: 'thunderbolt', model: futureCatalog.defaultModelId })

    expect((await runHarnessPrompt(binding)).stopReason).toBe('error')
    expect(harness.inferenceRequests).toHaveLength(1)
    expect(harness.producerCalls).toEqual({ byok: 0, direct: 1, confidential: 0, registration: 0 })
  })

  it('preserves a paid response when stored-status persistence fails', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const requests: Request[] = []
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requests.push(request)
        return successfulCompletion('acceptance-byok-model')
      },
    })
    const profile = {
      id: 'acceptance-byok',
      label: 'Acceptance BYOK',
      provider: 'openai-compat' as const,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      defaultModel: 'acceptance-byok-model',
      apiKey: 'stored-acceptance-key',
      credentialStatus: 'not-authenticated' as const,
    }
    const dependencies: ProviderRuntimeDependencies = {
      loadConfig: async () => ({
        version: 3,
        activeProviderId: profile.id,
        thunderbolt: { defaultModelId: bundledManagedCatalog.defaultModelId },
        providers: [profile],
      }),
      loadAuthConfig: async () => null,
      saveConfig: async () => {
        throw new Error('disk full')
      },
      resolveAccountCredential: async () => null,
      accountActions: {
        login: async () => {
          throw new Error('BYOK acceptance must not start web login')
        },
        logout: async () => 'logged-out',
      },
      loadCatalog: async () => bundledManagedCatalog,
      ensureRegisteredSession: async (credential) => credential,
      markSessionAuthenticationRequired: async () => {},
      metadata: { deviceName: 'Acceptance CLI' },
      createByokBinding,
      createManagedDirectBinding: async () => {
        throw new Error('unexpected managed-direct fallback')
      },
      createTinfoilBinding: async () => {
        throw new Error('unexpected confidential fallback')
      },
      environment: {},
      providerStage: createProviderStageContext(),
    }

    try {
      const { runtime } = await createTestProviderRuntime(dependencies)
      const binding = await runtime.prepare({ providerId: profile.id })

      const result = await runBinding(binding)

      expect(result.stopReason).toBe('stop')
      expect(result.content).toContainEqual({ type: 'text', text: 'future model' })
      expect(requests).toHaveLength(1)
      expect(runtime.snapshot().providers[0]?.status).toBe('not authenticated')
    } finally {
      errorLog.mockRestore()
      server.stop(true)
    }
  })
})
