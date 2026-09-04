/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Api, Model } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, spyOn, test } from 'bun:test'
import type { CliDeviceMetadata } from '../auth/account-client.ts'
import { createCredentialedFetch, type CredentialResponseObserver } from '../agent/credentialed-fetch.ts'
import { createByokBinding } from './byok.ts'
import { bundledManagedCatalog } from './catalog.ts'
import type {
  ByokProfile,
  CliAuth,
  CliConfig,
  ManagedCatalog,
  PreparedPiBinding,
  ProviderRuntimeError,
  ResolvedAccountCredential,
} from './types.ts'
import { providerRuntimeError } from './types.ts'
import { createProviderStageContext } from './provider-stage.ts'
import type { ProviderRuntimeDependencies } from './runtime.ts'
import { createTestProviderRuntime, futureDirectCatalog } from './test-fixtures.ts'

const directModel = bundledManagedCatalog.data.find(({ isConfidential }) => isConfidential === 0)
const confidentialModel = bundledManagedCatalog.data.find(({ isConfidential }) => isConfidential === 1)
if (!directModel || !confidentialModel) throw new Error('managed-model fixtures are incomplete')

const metadata: CliDeviceMetadata = { deviceName: 'Test CLI' }
const sessionCredential: Extract<ResolvedAccountCredential, { type: 'session' }> = {
  type: 'session',
  backendUrl: 'https://api.example.com/v1',
  bearer: 'stored-session',
  deviceId: 'cli-00000000-0000-7000-8000-000000000001',
  userCacheSecret: new Uint8Array(32).fill(7),
}
const patCredential: Extract<ResolvedAccountCredential, { type: 'pat' }> = {
  type: 'pat',
  backendUrl: 'https://api.example.com/v1',
  token: 'environment-pat',
}
const registeredAuth: CliAuth = {
  version: 2,
  backendUrl: sessionCredential.backendUrl,
  deviceId: sessionCredential.deviceId,
  userCacheSecret: Buffer.from(sessionCredential.userCacheSecret).toString('hex'),
  registration: 'registered',
  bearer: sessionCredential.bearer,
}

/** Narrows the two Fireworks protocols persisted by the CLI. */
const fireworksModelApi = (api: Api): 'anthropic-messages' | 'openai-completions' => {
  if (api === 'anthropic-messages') return 'anthropic-messages'
  if (api === 'openai-completions') return 'openai-completions'
  throw new Error(`Unexpected Fireworks API: ${api}`)
}

const profile = (overrides: Partial<ByokProfile> & Pick<ByokProfile, 'id' | 'label' | 'provider'>): ByokProfile => {
  const base = {
    id: overrides.id,
    label: overrides.label,
    defaultModel: overrides.defaultModel ?? 'gpt-5.6-sol',
    apiKey: overrides.apiKey ?? 'stored-key',
    credentialStatus: overrides.credentialStatus ?? ('authenticated' as const),
  }
  if (overrides.provider === 'openai-compat') {
    return { ...base, provider: 'openai-compat', baseUrl: overrides.baseUrl ?? 'https://models.example.com/v1' }
  }
  return { ...base, provider: overrides.provider }
}

const config = (overrides: Partial<CliConfig> = {}): CliConfig => ({
  version: 3,
  activeProviderId: 'work-openai',
  thunderbolt: { defaultModelId: directModel.id },
  providers: [
    profile({ id: 'work-openai', label: 'Work', provider: 'openai' }),
    profile({ id: 'personal-openai', label: 'Personal', provider: 'openai' }),
  ],
  ...overrides,
})

const runtimeError = (code: ProviderRuntimeError['code'], message: string = code): Error & ProviderRuntimeError =>
  providerRuntimeError(code, message)

const binding = (
  providerId: string,
  modelId: string,
  persistsCredentialStatus = true,
): PreparedPiBinding => ({
  providerId,
  wireModel: modelId,
  persistsCredentialStatus,
  piModel: { provider: providerId, id: modelId } as Model<Api>,
  install: () => {},
  attach: () => () => {},
  observePromptError: async () => {},
  dispose: async () => {},
})

const observeHttpResponse = async (observer: CredentialResponseObserver, status: number): Promise<void> => {
  const baseUrl = 'http://127.0.0.1/v1'
  await createCredentialedFetch(baseUrl, async () => new Response(null, { status }), observer)(`${baseUrl}/models`)
}

type RuntimeHarnessOptions = {
  readonly initialConfig?: CliConfig | null
  readonly credential?: ResolvedAccountCredential | null
  readonly auth?: CliAuth | null
  readonly catalog?: ManagedCatalog
  readonly saveFailure?: Error
  readonly byokBinding?: (
    profile: ByokProfile,
    persistsCredentialStatus: boolean,
  ) => PreparedPiBinding | Promise<PreparedPiBinding>
}

const createRuntimeHarness = async (options: RuntimeHarnessOptions = {}) => {
  const providerStage = createProviderStageContext()
  const saved: CliConfig[] = []
  const calls = {
    byok: 0,
    direct: 0,
    tinfoil: 0,
    register: 0,
    markSessionAuthenticationRequired: 0,
  }
  const byokArguments: {
    profile: ByokProfile
    selection: Parameters<ProviderRuntimeDependencies['createByokBinding']>[1]
    observeResponse: Parameters<ProviderRuntimeDependencies['createByokBinding']>[3]
  }[] = []
  const directArguments: Parameters<ProviderRuntimeDependencies['createManagedDirectBinding']>[0][] = []
  const tinfoilArguments: Parameters<ProviderRuntimeDependencies['createTinfoilBinding']>[0][] = []
  const markedCredentials: Array<Extract<ResolvedAccountCredential, { type: 'session' }> | undefined> = []
  const dependencyOverrides: ProviderRuntimeDependencies = {
    loadConfig: async () => (options.initialConfig === undefined ? config() : options.initialConfig),
    loadAuthConfig: async () => options.auth ?? null,
    saveConfig: async (next) => {
      if (options.saveFailure) throw options.saveFailure
      saved.push(next)
    },
    resolveAccountCredential: async () => options.credential ?? null,
    accountActions: {
      login: async () => ({
        version: 2,
        backendUrl: sessionCredential.backendUrl,
        deviceId: sessionCredential.deviceId,
        userCacheSecret: Buffer.from(sessionCredential.userCacheSecret).toString('hex'),
        registration: 'registered',
        bearer: sessionCredential.bearer,
      }),
      logout: async () => 'logged-out',
    },
    loadCatalog: async () => options.catalog ?? bundledManagedCatalog,
    ensureRegisteredSession: async (credential) => {
      calls.register += 1
      return credential
    },
    markSessionAuthenticationRequired: async (credential) => {
      calls.markSessionAuthenticationRequired += 1
      markedCredentials.push(credential)
    },
    metadata,
    createByokBinding: async (selectedProfile, selection, _environment, observeResponse) => {
      calls.byok += 1
      byokArguments.push({ profile: selectedProfile, selection, observeResponse })
      const persistsCredentialStatus = selection.apiKey === undefined
      return (
        options.byokBinding?.(selectedProfile, persistsCredentialStatus) ??
        binding(selectedProfile.id, selection.model ?? selectedProfile.defaultModel, persistsCredentialStatus)
      )
    },
    createManagedDirectBinding: async (bindingOptions) => {
      calls.direct += 1
      directArguments.push(bindingOptions)
      return binding(
        'thunderbolt',
        bindingOptions.model.id,
        false,
      )
    },
    createTinfoilBinding: async (bindingOptions) => {
      calls.tinfoil += 1
      tinfoilArguments.push(bindingOptions)
      return binding('thunderbolt', bindingOptions.model.id, false)
    },
    environment: {},
    providerStage,
  }
  const { runtime } = await createTestProviderRuntime(dependencyOverrides)
  return {
    runtime,
    dependencies: dependencyOverrides,
    providerStage,
    saved,
    calls,
    byokArguments,
    directArguments,
    tinfoilArguments,
    markedCredentials,
  }
}

describe('ProviderRuntime state and selection', () => {
  test('restores the exact durable config for a failed live switch and finalizes a successful one', async () => {
    const initial = config({ activeProviderId: 'work-openai' })
    const failed = await createRuntimeHarness({ initialConfig: initial })

    const committed = await failed.runtime.manage({
      type: 'commit-persistence',
      command: { type: 'use', providerId: 'personal-openai' },
    })
    await failed.runtime.manage({ type: 'rollback-persistence', revision: committed.revision })

    expect(failed.saved).toHaveLength(2)
    expect(failed.saved[0]?.activeProviderId).toBe('personal-openai')
    expect(failed.saved[1]).toEqual(initial)
    expect(failed.runtime.snapshot().activeProviderId).toBe('work-openai')

    const successful = await createRuntimeHarness({ initialConfig: initial })
    const successfulCommit = await successful.runtime.manage({
      type: 'commit-persistence',
      command: { type: 'use', providerId: 'personal-openai' },
    })
    await successful.runtime.manage({ type: 'finalize-persistence', revision: successfulCommit.revision })

    await expect(
      successful.runtime.manage({ type: 'rollback-persistence', revision: successfulCommit.revision }),
    ).rejects.toMatchObject({ code: 'persistence-failed' })
    expect(successful.saved).toHaveLength(1)
    expect(successful.runtime.snapshot().activeProviderId).toBe('personal-openai')

    const definitive = await createRuntimeHarness({ initialConfig: initial })
    const definitiveCommit = await definitive.runtime.manage({ type: 'use', providerId: 'personal-openai' })
    await expect(
      definitive.runtime.manage({ type: 'rollback-persistence', revision: definitiveCommit.revision }),
    ).rejects.toMatchObject({ code: 'persistence-failed' })
    expect(definitive.saved).toHaveLength(1)
  })

  test('restores BYOK evidence generations when a staged repair activation rolls back', async () => {
    const original = config().providers[0]
    if (!original) throw new Error('profile fixture is incomplete')
    const initial = config({ activeProviderId: original.id, providers: [original] })
    const { runtime, providerStage, byokArguments, saved } = await createRuntimeHarness({ initialConfig: initial })
    await runtime.prepare({})
    providerStage.stage({ ...original, apiKey: 'replacement-key' })

    const committed = await runtime.manage({
      type: 'commit-persistence',
      command: {
        type: 'commit-staged-byok',
        providerId: original.id,
        activate: false,
      },
    })
    await runtime.manage({ type: 'rollback-persistence', revision: committed.revision })
    if (!byokArguments[0]) throw new Error('expected the original binding observer')
    await observeHttpResponse(byokArguments[0].observeResponse, 401)

    expect(saved).toHaveLength(3)
    expect(saved.at(-1)?.providers[0]).toMatchObject({
      apiKey: original.apiKey,
      credentialStatus: 'authentication-required',
    })
  })

  test('atomically persists the exact Fireworks protocol across cross-protocol model switches and restarts', async () => {
    const fireworksModels = builtinModels().getModels('fireworks')
    const anthropic = fireworksModels.find(({ api }) => api === 'anthropic-messages')
    const openai = fireworksModels.find(({ api }) => api === 'openai-completions')
    if (!anthropic || !openai) throw new Error('Fireworks fixture must expose both protocols')

    for (const [from, to] of [
      [anthropic, openai],
      [openai, anthropic],
    ] as const) {
      const fireworksProfile: ByokProfile = {
        id: 'work-fireworks',
        label: 'Work Fireworks',
        provider: 'fireworks',
        defaultModel: from.id,
        modelApi: fireworksModelApi(from.api),
        apiKey: 'stored-key',
        credentialStatus: 'authenticated',
      }
      const initial = config({ activeProviderId: fireworksProfile.id, providers: [fireworksProfile] })
      const first = await createRuntimeHarness({ initialConfig: initial })

      await first.runtime.manage({ type: 'select-model', providerId: fireworksProfile.id, model: to.id })

      const persisted = first.saved.at(-1)
      expect(persisted?.providers[0]).toMatchObject({ defaultModel: to.id, modelApi: to.api })
      const restarted = await createRuntimeHarness({ initialConfig: persisted })
      await restarted.runtime.prepare({})
      expect(restarted.byokArguments[0]?.profile).toMatchObject({ defaultModel: to.id, modelApi: to.api })
    }
  })

  test('publishes the complete Pi Fireworks catalog for model selection', async () => {
    const firstFireworksModel = builtinModels().getModels('fireworks')[0]
    if (!firstFireworksModel) throw new Error('Fireworks fixture must expose at least one model')
    const fireworksProfile: ByokProfile = {
      id: 'work-fireworks',
      label: 'Work Fireworks',
      provider: 'fireworks',
      defaultModel: firstFireworksModel.id,
      modelApi: fireworksModelApi(firstFireworksModel.api),
      apiKey: 'stored-key',
      credentialStatus: 'authenticated',
    }
    const { runtime } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: fireworksProfile.id, providers: [fireworksProfile] }),
    })

    expect(runtime.snapshot().providers[0]?.models?.map(({ id }) => id)).toEqual(
      builtinModels()
        .getModels('fireworks')
        .map(({ id }) => id),
    )
  })

  test.each([
    ['registered', registeredAuth, 'authenticated'],
    [
      'authentication-required',
      { ...registeredAuth, registration: 'authentication-required', bearer: null },
      'authentication required',
    ],
    ['legacy', { ...registeredAuth, registration: 'legacy' }, 'not authenticated'],
    ['absent', null, 'not authenticated'],
  ] as const)('rehydrates %s stored auth as %s', async (_kind, auth, expectedStatus) => {
    const { runtime } = await createRuntimeHarness({
      auth,
    })

    expect(runtime.snapshot().thunderbolt.status).toBe(expectedStatus)
  })

  test('keeps an environment PAT process-local on restart', async () => {
    const { runtime } = await createRuntimeHarness({ credential: patCredential, auth: null })
    expect(runtime.snapshot().thunderbolt.status).toBe('not authenticated')
  })

  test('does not let a registered stored session authenticate the effective PAT', async () => {
    const { runtime } = await createRuntimeHarness({ credential: patCredential, auth: registeredAuth })
    expect(runtime.snapshot().thunderbolt.status).toBe('not authenticated')
  })

  test('returns a fresh plain Thunderbolt snapshot with persisted BYOK status', async () => {
    const initial = config({
      activeProviderId: 'personal-openai',
      providers: [
        profile({ id: 'work-openai', label: 'Work', provider: 'openai' }),
        profile({
          id: 'personal-openai',
          label: 'Personal',
          provider: 'openai',
          credentialStatus: 'authentication-required',
        }),
      ],
    })
    const { runtime } = await createRuntimeHarness({ initialConfig: initial })

    const snapshot = runtime.snapshot()

    expect(snapshot).toMatchObject({
      revision: 0,
      activeProviderId: 'personal-openai',
      thunderbolt: { status: 'not authenticated', defaultModelId: directModel.id },
      providers: [
        {
          id: 'work-openai',
          label: 'Work',
          provider: 'openai',
          status: 'authenticated',
          defaultModel: 'gpt-5.6-sol',
        },
        {
          id: 'personal-openai',
          label: 'Personal',
          provider: 'openai',
          status: 'authentication required',
          defaultModel: 'gpt-5.6-sol',
        },
      ],
    })
    expect(snapshot.thunderbolt.models).toEqual([])
    expect(runtime.snapshot()).not.toBe(snapshot)
  })

  test('resolves exact stable ids and unique label/provider shorthand without changing config', async () => {
    const unique = profile({ id: 'only-google', label: 'Research', provider: 'google', defaultModel: 'gemini-test' })
    const initial = config({ activeProviderId: unique.id, providers: [unique] })
    const { runtime, saved, byokArguments } = await createRuntimeHarness({ initialConfig: initial })

    expect((await runtime.prepare({ providerId: unique.id })).providerId).toBe(unique.id)
    expect((await runtime.prepare({ providerId: 'Research' })).providerId).toBe(unique.id)
    expect((await runtime.prepare({ providerId: 'google' })).providerId).toBe(unique.id)

    expect(byokArguments.map(({ profile: selected }) => selected.id)).toEqual([unique.id, unique.id, unique.id])
    expect(saved).toEqual([])
    expect(runtime.snapshot().activeProviderId).toBe(unique.id)
  })

  test('rejects ambiguous shorthand with every matching stable id and invokes no producer', async () => {
    const { runtime, calls } = await createRuntimeHarness()

    await expect(runtime.prepare({ providerId: 'openai' })).rejects.toMatchObject({
      code: 'provider-not-found',
    })
    await expect(runtime.prepare({ providerId: 'openai' })).rejects.toThrow('work-openai')
    await expect(runtime.prepare({ providerId: 'openai' })).rejects.toThrow('personal-openai')
    expect(calls).toMatchObject({ byok: 0, direct: 0, tinfoil: 0 })
  })

  test('prepares an unsaved openai-compat invocation through the provider stage without persistence', async () => {
    const baseUrl = 'https://models.example.com/v1'
    const model = 'compat-model'
    const saved: CliConfig[] = []
    const { dependencies, runtime } = await createTestProviderRuntime({
      loadConfig: async () => null,
      saveConfig: async (next) => {
        saved.push(next)
      },
      createByokBinding,
      environment: { THUNDERBOLT_OPENAI_COMPAT_KEY: 'dedicated-key' },
    })

    const prepared = await runtime.prepare({ providerId: 'openai-compat', baseUrl, model })

    expect(prepared).toMatchObject({ providerId: 'openai-compat', wireModel: model, persistsCredentialStatus: false })
    expect(prepared.piModel).toMatchObject({ provider: 'openai-compat', id: model, baseUrl })
    expect(dependencies.providerStage.get('openai-compat')).not.toBeNull()
    expect(runtime.snapshot()).toMatchObject({ activeProviderId: null, providers: [] })
    expect(saved).toEqual([])

    await prepared.dispose()
    expect(dependencies.providerStage.get('openai-compat')).toBeNull()
  })

  test('reports the missing base URL for an unsaved openai-compat invocation', async () => {
    const { runtime } = await createTestProviderRuntime({ loadConfig: async () => null })

    await expect(
      runtime.prepare({ providerId: 'openai-compat', model: 'compat-model', apiKey: 'flag-key' }),
    ).rejects.toMatchObject({
      code: 'config-invalid',
      message: expect.stringMatching(/--base-url/i),
    })
  })

  test('reports the missing model for each unsaved openai-compat invocation', async () => {
    const { runtime } = await createTestProviderRuntime({
      loadConfig: async () => null,
      createByokBinding,
      environment: { THUNDERBOLT_OPENAI_COMPAT_KEY: 'dedicated-key' },
    })
    const prepared = await runtime.prepare({
      providerId: 'openai-compat',
      baseUrl: 'https://first.example.com/v1',
      model: 'first-compat-model',
    })

    await expect(
      runtime.prepare({ providerId: 'openai-compat', baseUrl: 'https://second.example.com/v1' }),
    ).rejects.toMatchObject({
      code: 'config-invalid',
      message: expect.stringMatching(/--model/i),
    })

    await prepared.dispose()
  })

  test('prefers a saved openai-compat profile over an ad-hoc stage', async () => {
    const providerStage = createProviderStageContext()
    providerStage.stage(
      profile({
        id: 'openai-compat',
        label: 'Ad-hoc compatible',
        provider: 'openai-compat',
        defaultModel: 'ad-hoc-model',
      }),
    )
    const savedProfile = profile({
      id: 'saved-compatible',
      label: 'Saved compatible',
      provider: 'openai-compat',
      defaultModel: 'saved-model',
    })
    const { runtime } = await createTestProviderRuntime({
      loadConfig: async () => config({ activeProviderId: savedProfile.id, providers: [savedProfile] }),
      providerStage,
    })

    const prepared = await runtime.prepare({ providerId: 'openai-compat' })

    expect(prepared).toMatchObject({ providerId: savedProfile.id, wireModel: savedProfile.defaultModel })
  })

  test('rejects an ad-hoc openai-compat invocation with only another provider credential', async () => {
    const otherProviderKey = 'anthropic-only-key'
    const { dependencies, runtime } = await createTestProviderRuntime({
      loadConfig: async () => null,
      createByokBinding,
      environment: { ANTHROPIC_API_KEY: otherProviderKey },
    })

    await expect(
      runtime.prepare({
        providerId: 'openai-compat',
        baseUrl: 'https://isolated.example.com/v1',
        model: 'isolated-compat-model',
      }),
    ).rejects.toMatchObject({
      code: 'authentication-required',
      message: expect.stringMatching(/THUNDERBOLT_OPENAI_COMPAT_KEY/),
    })
    expect(dependencies.providerStage.get('openai-compat')).toBeNull()
  })

  test('passes all four process overrides to one profile while persisting none of them', async () => {
    const selected = profile({
      id: 'custom',
      label: 'Custom',
      provider: 'openai-compat',
      baseUrl: 'https://stored.example/v1',
      defaultModel: 'stored-model',
      apiKey: 'stored-key',
    })
    const initial = config({ activeProviderId: selected.id, providers: [selected] })
    const { runtime, saved, byokArguments } = await createRuntimeHarness({ initialConfig: initial })

    await runtime.prepare({
      providerId: selected.id,
      model: 'override-model',
      apiKey: 'override-key',
      baseUrl: 'https://override.example/v1',
    })

    expect(byokArguments[0]).toMatchObject({
      profile: selected,
      selection: {
        providerId: selected.id,
        model: 'override-model',
        apiKey: 'override-key',
        baseUrl: 'https://override.example/v1',
      },
    })
    expect(saved).toEqual([])
    expect(runtime.snapshot()).toMatchObject({ activeProviderId: selected.id })
    expect(runtime.snapshot().providers[0]).toMatchObject({ defaultModel: 'stored-model' })
  })

  test('rejects a remote cleartext compatible endpoint before handing any credential to a producer', async () => {
    const selected = profile({
      id: 'custom',
      label: 'Custom',
      provider: 'openai-compat',
      baseUrl: 'https://stored.example/v1',
    })
    const { runtime, calls, saved } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: selected.id, providers: [selected] }),
    })

    await expect(
      runtime.prepare({
        providerId: selected.id,
        apiKey: 'override-key',
        baseUrl: 'http://models.example/v1',
      }),
    ).rejects.toMatchObject({ code: 'config-invalid' })

    expect(calls).toMatchObject({ byok: 0, direct: 0, tinfoil: 0 })
    expect(saved).toEqual([])

    const adHoc = await createTestProviderRuntime({
      loadConfig: async () => null,
      createByokBinding,
    })
    await expect(
      adHoc.runtime.prepare({
        providerId: 'openai-compat',
        apiKey: 'flag-key',
        baseUrl: 'http://models.example/v1',
        model: 'cleartext-compat-model',
      }),
    ).rejects.toMatchObject({ code: 'config-invalid' })
    expect(adHoc.dependencies.providerStage.get('openai-compat')).toBeNull()
  })

  test('writes the complete next config before publishing it and leaves state unchanged on failure', async () => {
    const writeError = new Error('disk full')
    const { runtime, saved } = await createRuntimeHarness({ saveFailure: writeError })
    const before = runtime.snapshot()

    await expect(runtime.manage({ type: 'use', providerId: 'personal-openai' })).rejects.toMatchObject({
      code: 'persistence-failed',
    })

    expect(saved).toEqual([])
    expect(runtime.snapshot()).toEqual(before)
    expect(runtime.snapshot().revision).toBe(0)
  })

  test('retains authentication-required status when a later persisted write fails', async () => {
    const migrated = profile({
      id: 'environment-google',
      label: 'Environment Google',
      provider: 'google',
      apiKey: null,
      credentialStatus: 'authentication-required',
    })
    const { runtime, providerStage } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: migrated.id, providers: [migrated] }),
      saveFailure: new Error('disk full'),
      byokBinding: (selected) => binding(selected.id, selected.defaultModel, false),
    })
    await runtime.prepare({})
    expect(runtime.snapshot().providers[0]?.status).toBe('authentication required')

    providerStage.stage({ ...migrated, label: 'Renamed' })
    await expect(
      runtime.manage({ type: 'commit-staged-byok', providerId: migrated.id, activate: false }),
    ).rejects.toMatchObject({ code: 'persistence-failed' })

    expect(runtime.snapshot().providers[0]).toMatchObject({
      label: 'Environment Google',
      status: 'authentication required',
    })
  })

  test('never exposes mutable internal config objects to an injected producer', async () => {
    const { runtime } = await createRuntimeHarness({
      byokBinding: (selected) => {
        Object.assign(selected, { label: 'Mutated by producer' })
        return binding(selected.id, selected.defaultModel)
      },
    })

    await runtime.prepare({ providerId: 'work-openai' })

    expect(runtime.snapshot().providers[0]?.label).toBe('Work')
  })

  test('serializes concurrent config mutations so neither committed update is lost', async () => {
    const persisted: CliConfig[] = []
    const firstWrite = Promise.withResolvers<void>()
    let writes = 0
    const { dependencies } = await createRuntimeHarness()
    const { runtime } = await createTestProviderRuntime({
      ...dependencies,
      saveConfig: async (next) => {
        writes += 1
        if (writes === 1) await firstWrite.promise
        persisted.push(next)
      },
    })

    const use = runtime.manage({ type: 'use', providerId: 'personal-openai' })
    const select = runtime.manage({
      type: 'select-model',
      providerId: 'personal-openai',
      model: 'gpt-5.6-sol-mini',
    })
    await Promise.resolve()
    expect(persisted).toEqual([])
    firstWrite.resolve()
    await Promise.all([use, select])

    expect(persisted).toHaveLength(2)
    expect(persisted[1]).toMatchObject({ activeProviderId: 'personal-openai' })
    expect(persisted[1]?.providers.find(({ id }) => id === 'personal-openai')).toMatchObject({
      defaultModel: 'gpt-5.6-sol-mini',
    })
    expect(runtime.snapshot()).toMatchObject({ revision: 2, activeProviderId: 'personal-openai' })
  })

  test('activates only explicit save-and-use while active and inactive repairs preserve selection', async () => {
    const { runtime, saved, providerStage } = await createRuntimeHarness()
    const work = config().providers[0]
    const personal = config().providers[1]
    if (!work || !personal) throw new Error('profile fixtures are incomplete')

    providerStage.stage({ ...personal, apiKey: 'repaired-personal-key', credentialStatus: 'authenticated' })
    await runtime.manage({ type: 'commit-staged-byok', providerId: personal.id, activate: false })
    expect(runtime.snapshot().activeProviderId).toBe(work.id)

    providerStage.stage({ ...work, apiKey: 'repaired-work-key', credentialStatus: 'authenticated' })
    await runtime.manage({ type: 'commit-staged-byok', providerId: work.id, activate: false })
    expect(runtime.snapshot().activeProviderId).toBe(work.id)

    const added = profile({ id: 'new-google', label: 'New Google', provider: 'google' })
    providerStage.stage(added)
    await runtime.manage({ type: 'commit-staged-byok', providerId: added.id, activate: true })

    expect(runtime.snapshot().activeProviderId).toBe(added.id)
    expect(saved.at(-1)).toMatchObject({ activeProviderId: added.id })
    expect(saved.at(-1)?.providers.find(({ id }) => id === added.id)).toEqual(added)
  })

  test('does not let an old prepared binding clear a newer staged repair for the same profile', async () => {
    const original = config().providers[0]
    if (!original) throw new Error('profile fixture is incomplete')
    const { runtime, providerStage, byokArguments } = await createRuntimeHarness()

    providerStage.stage({ ...original, apiKey: 'first-repair' })
    const firstBinding = await runtime.prepare({ providerId: original.id })
    await runtime.manage({ type: 'commit-staged-byok', providerId: original.id, activate: false })

    providerStage.stage({ ...original, apiKey: 'second-repair' })
    await firstBinding.dispose()
    await runtime.prepare({ providerId: original.id })

    expect(byokArguments.map(({ profile: selected }) => selected.apiKey)).toEqual(['first-repair', 'second-repair'])
  })
})

describe('ProviderRuntime one-producer managed dispatch', () => {
  test('dispatches BYOK, managed direct, confidential, and future direct to exactly one producer each', async () => {
    const byokHarness = await createRuntimeHarness()
    await byokHarness.runtime.prepare({ providerId: 'work-openai' })
    expect(byokHarness.calls).toMatchObject({ byok: 1, direct: 0, tinfoil: 0 })

    const directHarness = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    await directHarness.runtime.prepare({ providerId: 'thunderbolt', model: directModel.model })
    expect(directHarness.calls).toMatchObject({ byok: 0, direct: 1, tinfoil: 0, register: 1 })

    const tinfoilHarness = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    await tinfoilHarness.runtime.prepare({ providerId: 'thunderbolt', model: confidentialModel.id })
    expect(tinfoilHarness.calls).toMatchObject({ byok: 0, direct: 0, tinfoil: 1, register: 1 })

    const futureCatalog = futureDirectCatalog
    const futureHarness = await createRuntimeHarness({
      initialConfig: config({
        activeProviderId: 'thunderbolt',
        thunderbolt: { defaultModelId: futureCatalog.defaultModelId },
      }),
      credential: patCredential,
      catalog: futureCatalog,
    })
    await futureHarness.runtime.prepare({ providerId: 'thunderbolt', model: 'future-direct-fixture' })
    expect(futureHarness.calls).toMatchObject({ byok: 0, direct: 1, tinfoil: 0, register: 0 })
    expect(futureHarness.directArguments[0]?.model).toEqual(futureCatalog.data[0])
  })

  test('never tries an alternate producer after the selected producer fails', async () => {
    const byokHarness = await createRuntimeHarness()
    const { runtime: byokRuntime } = await createTestProviderRuntime({
      ...byokHarness.dependencies,
      createByokBinding: async () => {
        byokHarness.calls.byok += 1
        throw runtimeError('authentication-required')
      },
    })
    await expect(byokRuntime.prepare({ providerId: 'work-openai' })).rejects.toMatchObject({
      code: 'authentication-required',
    })
    expect(byokHarness.calls).toMatchObject({ byok: 1, direct: 0, tinfoil: 0 })

    const directHarness = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    const { runtime: directRuntime } = await createTestProviderRuntime({
      ...directHarness.dependencies,
      createManagedDirectBinding: async () => {
        directHarness.calls.direct += 1
        throw runtimeError('network')
      },
    })
    await expect(directRuntime.prepare({ model: directModel.id })).rejects.toMatchObject({ code: 'network' })
    expect(directHarness.calls).toMatchObject({ byok: 0, direct: 1, tinfoil: 0 })

    const tinfoilHarness = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    const { runtime: tinfoilRuntime } = await createTestProviderRuntime({
      ...tinfoilHarness.dependencies,
      createTinfoilBinding: async () => {
        tinfoilHarness.calls.tinfoil += 1
        throw runtimeError('attestation-failed')
      },
    })
    await expect(tinfoilRuntime.prepare({ model: confidentialModel.model })).rejects.toMatchObject({
      code: 'attestation-failed',
    })
    expect(tinfoilHarness.calls).toMatchObject({ byok: 0, direct: 0, tinfoil: 1 })
  })

  test('rejects a model outside the chosen managed owner before invoking a producer', async () => {
    const { runtime, calls } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })

    await expect(runtime.prepare({ model: 'not-in-the-managed-catalog' })).rejects.toMatchObject({
      code: 'model-not-found',
    })
    expect(calls).toMatchObject({ byok: 0, direct: 0, tinfoil: 0 })
  })
})

describe('ProviderRuntime account registration and rejection policy', () => {
  test('creates and manages providers/logout without eagerly loading an unavailable catalog', async () => {
    const { dependencies } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
      auth: registeredAuth,
    })
    const { runtime } = await createTestProviderRuntime({
      ...dependencies,
      loadCatalog: async () => {
        throw new Error('config offline')
      },
    })

    expect(runtime.snapshot().thunderbolt.models).toEqual([])
    expect(await runtime.manage({ type: 'use', providerId: 'work-openai' })).toMatchObject({
      activeProviderId: 'work-openai',
    })
    await expect(runtime.manage({ type: 'load-models', providerId: 'thunderbolt' })).rejects.toThrow('config offline')
    await expect(
      runtime.manage({
        type: 'logout',
        presentation: { showVerification: () => {}, showStatus: () => {} },
      }),
    ).resolves.toBeDefined()
  })

  test('loads model choices without preparing the saved confidential model for a PAT', async () => {
    const { runtime, calls } = await createRuntimeHarness({
      initialConfig: config({
        activeProviderId: 'thunderbolt',
        thunderbolt: { defaultModelId: confidentialModel.id },
      }),
      credential: patCredential,
    })

    await runtime.manage({ type: 'load-models', providerId: 'thunderbolt' })
    const options = runtime.snapshot().thunderbolt.models

    expect(options).toHaveLength(bundledManagedCatalog.data.length)
    expect(calls).toMatchObject({ direct: 0, tinfoil: 0, register: 0 })
    expect(runtime.snapshot().thunderbolt.status).toBe('not authenticated')
  })

  test('loads and exposes the complete managed catalog immediately after web login', async () => {
    let catalogLoads = 0
    const { dependencies } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: null }),
      credential: null,
    })
    const { runtime } = await createTestProviderRuntime({
      ...dependencies,
      loadCatalog: async (backendUrl) => {
        catalogLoads += 1
        expect(backendUrl).toBe(sessionCredential.backendUrl)
        return bundledManagedCatalog
      },
    })

    await runtime.manage({
      type: 'login',
      presentation: { showVerification: () => {}, showStatus: () => {} },
    })

    expect(catalogLoads).toBe(1)
    expect(runtime.snapshot().thunderbolt.models).toEqual(
      bundledManagedCatalog.data.map((model) => ({
        id: model.id,
        label: model.name,
        description: `${model.model} — ${model.description}`,
        wireModel: model.model,
        confidential: model.isConfidential === 1,
      })),
    )
  })

  test('persists the login-selected managed UUID in the same activation transaction', async () => {
    const selected = bundledManagedCatalog.data[1]
    if (!selected) throw new Error('managed catalog fixture needs two models')
    const { runtime, saved } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: null }),
      credential: sessionCredential,
    })
    await runtime.manage({
      type: 'login',
      presentation: { showVerification: () => {}, showStatus: () => {} },
    })
    await runtime.manage({ type: 'use', providerId: 'thunderbolt', model: selected.id })

    expect(saved.at(-1)).toMatchObject({
      activeProviderId: 'thunderbolt',
      thunderbolt: { defaultModelId: selected.id },
    })
  })

  test('registers every session-backed managed prepare before its sole producer', async () => {
    const events: string[] = []
    const { dependencies } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    const { runtime } = await createTestProviderRuntime({
      ...dependencies,
      ensureRegisteredSession: async (credential) => {
        events.push('register')
        return credential
      },
      createManagedDirectBinding: async (options) => {
        events.push('direct')
        return binding('thunderbolt', options.model.id, false)
      },
    })

    await runtime.prepare({ model: directModel.id })
    await runtime.prepare({ model: directModel.id })

    expect(events).toEqual(['register', 'direct', 'register', 'direct'])
  })

  test('publishes authentication-required when session registration rejects before a producer', async () => {
    const { dependencies, calls } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    const { runtime } = await createTestProviderRuntime({
      ...dependencies,
      ensureRegisteredSession: async () => {
        throw runtimeError('authentication-required', 'Stored session expired.')
      },
    })

    await expect(runtime.prepare({ model: directModel.id })).rejects.toMatchObject({
      code: 'authentication-required',
    })

    expect(runtime.snapshot().thunderbolt.status).toBe('authentication required')
    expect(calls).toMatchObject({ direct: 0, tinfoil: 0 })
  })

  test('lets PAT direct skip registration', async () => {
    const directHarness = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: patCredential,
    })
    await directHarness.runtime.prepare({ model: directModel.id })
    expect(directHarness.calls).toMatchObject({ register: 0, direct: 1, tinfoil: 0 })
    expect(directHarness.runtime.snapshot().thunderbolt.status).toBe('not authenticated')

  })

  test('stored BYOK rejection marks only that profile while flag and environment paths remain process-only', async () => {
    const initial = config()
    const stored = await createRuntimeHarness({ initialConfig: initial })
    await stored.runtime.prepare({ providerId: 'work-openai' })
    if (stored.byokArguments[0]) await observeHttpResponse(stored.byokArguments[0].observeResponse, 401)
    expect(stored.saved.at(-1)?.providers).toEqual([
      { ...initial.providers[0], credentialStatus: 'authentication-required' },
      initial.providers[1],
    ])
    expect(stored.calls.markSessionAuthenticationRequired).toBe(0)

    const flag = await createRuntimeHarness({ initialConfig: initial })
    await flag.runtime.prepare({ providerId: 'work-openai', apiKey: 'flag-key' })
    expect(flag.saved).toEqual([])
    if (flag.byokArguments[0]) await observeHttpResponse(flag.byokArguments[0].observeResponse, 403)
    expect(flag.runtime.snapshot().providers[0]?.status).toBe('authentication required')
    expect(flag.calls.markSessionAuthenticationRequired).toBe(0)

    const environment = await createRuntimeHarness({
      initialConfig: initial,
      byokBinding: (selected) => binding(selected.id, selected.defaultModel, false),
    })
    await environment.runtime.prepare({ providerId: 'work-openai' })
    expect(environment.saved).toEqual([])
    if (environment.byokArguments[0]) {
      await observeHttpResponse(environment.byokArguments[0].observeResponse, 401)
    }
    expect(environment.runtime.snapshot().providers[0]?.status).toBe('authentication required')
    expect(environment.calls.markSessionAuthenticationRequired).toBe(0)
  })

  test('stored-session rejection invokes the injected auth mutation while PAT rejection cannot', async () => {
    const session = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
    })
    await session.runtime.prepare({ model: directModel.id })
    if (session.directArguments[0]) await observeHttpResponse(session.directArguments[0].observeResponse, 401)
    expect(session.calls.markSessionAuthenticationRequired).toBe(1)
    expect(session.markedCredentials).toEqual([sessionCredential])
    expect(session.runtime.snapshot().thunderbolt.status).toBe('authentication required')

    const pat = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: patCredential,
    })
    await pat.runtime.prepare({ model: directModel.id })
    if (pat.directArguments[0]) await observeHttpResponse(pat.directArguments[0].observeResponse, 401)
    expect(pat.calls.markSessionAuthenticationRequired).toBe(0)
    expect(pat.runtime.snapshot().thunderbolt.status).toBe('authentication required')
  })

  test('keeps PAT status process-local and changes it only after a real direct response', async () => {
    const pat = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: patCredential,
    })
    await pat.runtime.prepare({ model: directModel.id })
    expect(pat.runtime.snapshot().thunderbolt.status).toBe('not authenticated')

    if (pat.directArguments[0]) await observeHttpResponse(pat.directArguments[0].observeResponse, 200)
    expect(pat.runtime.snapshot().thunderbolt.status).toBe('authenticated')

    if (pat.directArguments[0]) await observeHttpResponse(pat.directArguments[0].observeResponse, 503)
    expect(pat.runtime.snapshot().thunderbolt.status).toBe('authenticated')
    if (pat.directArguments[0]) await observeHttpResponse(pat.directArguments[0].observeResponse, 429)
    expect(pat.runtime.snapshot().thunderbolt.status).toBe('authenticated')
    if (pat.directArguments[0]) await observeHttpResponse(pat.directArguments[0].observeResponse, 403)
    expect(pat.runtime.snapshot().thunderbolt.status).toBe('authentication required')
    expect(pat.calls.markSessionAuthenticationRequired).toBe(0)
  })

  test('keeps a validated PAT usable when logout reports external management, then forgets it on restart', async () => {
    const { dependencies } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: patCredential,
    })
    const responses: Parameters<ProviderRuntimeDependencies['createManagedDirectBinding']>[0][] = []
    const { runtime: observedRuntime } = await createTestProviderRuntime({
      ...dependencies,
      accountActions: {
        ...dependencies.accountActions,
        logout: async () => 'pat-managed-externally',
      },
      createManagedDirectBinding: async (options) => {
        responses.push(options)
        return binding('thunderbolt', options.model.id, false)
      },
    })
    await observedRuntime.prepare({ model: directModel.id })
    if (responses[0]) await observeHttpResponse(responses[0].observeResponse, 200)
    await observedRuntime.manage({
      type: 'logout',
      presentation: { showVerification: () => {}, showStatus: () => {} },
    })
    expect(observedRuntime.snapshot().thunderbolt.status).toBe('authenticated')

    const { runtime: restarted } = await createTestProviderRuntime(dependencies)
    expect(restarted.snapshot().thunderbolt.status).toBe('not authenticated')
  })

  test('session logout with a PAT preserves only evidence already observed for that PAT', async () => {
    const create = async (status?: number) => {
      const responses: Parameters<ProviderRuntimeDependencies['createManagedDirectBinding']>[0][] = []
      const { dependencies } = await createRuntimeHarness({ credential: patCredential, auth: registeredAuth })
      const { runtime } = await createTestProviderRuntime({
        ...dependencies,
        accountActions: { ...dependencies.accountActions, logout: async () => 'logged-out' },
        createManagedDirectBinding: async (options) => {
          responses.push(options)
          return binding('thunderbolt', options.model.id, false)
        },
      })
      if (status !== undefined) {
        await runtime.prepare({ providerId: 'thunderbolt', model: directModel.id })
        if (responses[0]) await observeHttpResponse(responses[0].observeResponse, status)
      }
      await runtime.manage({
        type: 'logout',
        presentation: { showVerification: () => {}, showStatus: () => {} },
      })
      return runtime.snapshot().thunderbolt.status
    }

    expect(await create()).toBe('not authenticated')
    expect(await create(200)).toBe('authenticated')
    expect(await create(401)).toBe('authentication required')
  })

  test('publishes authoritative logout state when terminal cancellation races with the response', async () => {
    const controller = new AbortController()
    const { dependencies } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
      auth: registeredAuth,
    })
    const { runtime } = await createTestProviderRuntime({
      ...dependencies,
      accountActions: {
        ...dependencies.accountActions,
        logout: async () => {
          controller.abort()
          return 'logged-out'
        },
      },
    })
    const presentation = {
      showVerification: () => {},
      showStatus: () => {},
      signal: controller.signal,
    }

    await expect(runtime.manage({ type: 'logout', presentation })).resolves.toMatchObject({
      thunderbolt: { status: 'not authenticated' },
    })
  })

  test('persists stored BYOK success but keeps flag and environment success process-local', async () => {
    const initial = config({
      providers: [
        profile({
          id: 'legacy-openai',
          label: 'Legacy',
          provider: 'openai',
          credentialStatus: 'authentication-required',
        }),
      ],
      activeProviderId: 'legacy-openai',
    })
    const stored = await createRuntimeHarness({ initialConfig: initial })
    await stored.runtime.prepare({})
    if (stored.byokArguments[0]) await observeHttpResponse(stored.byokArguments[0].observeResponse, 200)
    expect(stored.saved.at(-1)?.providers[0]?.credentialStatus).toBe('authenticated')

    const processOnly = await createRuntimeHarness({
      initialConfig: initial,
      byokBinding: (selected) => binding(selected.id, selected.defaultModel, false),
    })
    await processOnly.runtime.prepare({})
    if (processOnly.byokArguments[0]) {
      await observeHttpResponse(processOnly.byokArguments[0].observeResponse, 200)
    }
    expect(processOnly.saved).toEqual([])
    expect(processOnly.runtime.snapshot().providers[0]?.status).toBe('authenticated')
  })

  test('keeps a successful provider response usable when persisted status bookkeeping fails', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const initialProfile = profile({
      id: 'bookkeeping-profile',
      label: 'Bookkeeping',
      provider: 'openai',
      credentialStatus: 'not-authenticated',
    })
    const { runtime, byokArguments, saved } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: initialProfile.id, providers: [initialProfile] }),
      saveFailure: new Error('disk full'),
    })
    await runtime.prepare({})

    try {
      await expect(observeHttpResponse(byokArguments[0]!.observeResponse, 200)).resolves.toBeUndefined()

      expect(saved).toEqual([])
      expect(runtime.snapshot().providers[0]?.status).toBe('not authenticated')
      expect(errorLog).toHaveBeenCalledTimes(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  test('ignores late evidence from a BYOK binding replaced by a repaired key', async () => {
    const initialProfile = profile({
      id: 'rotated-profile',
      label: 'Rotated',
      provider: 'openai',
      credentialStatus: 'not-authenticated',
      apiKey: 'old-key',
    })
    const { runtime, byokArguments, saved, providerStage } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: initialProfile.id, providers: [initialProfile] }),
    })
    await runtime.prepare({})
    providerStage.stage({ ...initialProfile, apiKey: 'new-key', credentialStatus: 'not-authenticated' })
    await runtime.manage({ type: 'commit-staged-byok', providerId: initialProfile.id, activate: false })

    if (byokArguments[0]) await observeHttpResponse(byokArguments[0].observeResponse, 401)

    expect(saved).toHaveLength(1)
    expect(saved[0]?.providers[0]).toMatchObject({ apiKey: 'new-key', credentialStatus: 'not-authenticated' })
    expect(runtime.snapshot().providers[0]?.status).toBe('not authenticated')
  })

  test('ignores late rejection from a session binding after a successful relogin', async () => {
    const { runtime, directArguments, calls } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
      auth: registeredAuth,
    })
    await runtime.prepare({ model: directModel.id })
    await runtime.manage({
      type: 'login',
      presentation: { showVerification: () => {}, showStatus: () => {} },
    })

    if (directArguments[0]) await observeHttpResponse(directArguments[0].observeResponse, 401)

    expect(calls.markSessionAuthenticationRequired).toBe(0)
    expect(runtime.snapshot().thunderbolt.status).toBe('authenticated')
  })

  test('does not publish an old managed prepare whose credential resolution finishes after relogin', async () => {
    const renewedCredential = { ...sessionCredential, bearer: 'renewed-session' }
    const resolutionStarted = Promise.withResolvers<void>()
    const releaseOldResolution = Promise.withResolvers<void>()
    let resolution = 0
    let directBindings = 0
    const base = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
      auth: registeredAuth,
    })
    const { runtime } = await createTestProviderRuntime({
      ...base.dependencies,
      resolveAccountCredential: async () => {
        resolution += 1
        if (resolution === 1) return sessionCredential
        if (resolution === 2) {
          resolutionStarted.resolve()
          await releaseOldResolution.promise
          return sessionCredential
        }
        return renewedCredential
      },
      accountActions: {
        ...base.dependencies.accountActions,
        login: async () => ({
          ...registeredAuth,
          bearer: renewedCredential.bearer,
        }),
      },
      createManagedDirectBinding: async (options) => {
        directBindings += 1
        return binding('thunderbolt', options.model.id, false)
      },
    })

    const stalePrepare = runtime.prepare({ model: directModel.id })
    await resolutionStarted.promise
    await runtime.manage({
      type: 'login',
      presentation: { showVerification: () => {}, showStatus: () => {} },
    })
    releaseOldResolution.resolve()

    await expect(stalePrepare).rejects.toMatchObject({
      code: 'authentication-required',
    })
    expect(directBindings).toBe(0)
    expect(runtime.snapshot().thunderbolt.status).toBe('authenticated')
  })

  test.each(['direct', 'confidential'] as const)(
    'rechecks account generation inside the mutation lane before a stale %s rejection clears durable auth',
    async (transport) => {
      const renewedCredential = { ...sessionCredential, bearer: 'renewed-session' }
      let currentCredential: ResolvedAccountCredential = sessionCredential
      let durableClears = 0
      const loginStarted = Promise.withResolvers<void>()
      const releaseLogin = Promise.withResolvers<void>()
      const base = await createRuntimeHarness({
        initialConfig: config({ activeProviderId: 'thunderbolt' }),
        credential: sessionCredential,
        auth: registeredAuth,
      })
      const directArguments: Parameters<ProviderRuntimeDependencies['createManagedDirectBinding']>[0][] = []
      const tinfoilArguments: Parameters<ProviderRuntimeDependencies['createTinfoilBinding']>[0][] = []
      const { runtime } = await createTestProviderRuntime({
        ...base.dependencies,
        resolveAccountCredential: async () => currentCredential,
        accountActions: {
          ...base.dependencies.accountActions,
          login: async () => {
            loginStarted.resolve()
            await releaseLogin.promise
            currentCredential = renewedCredential
            return { ...registeredAuth, bearer: renewedCredential.bearer }
          },
        },
        markSessionAuthenticationRequired: async () => {
          durableClears += 1
        },
        createManagedDirectBinding: async (options) => {
          directArguments.push(options)
          return binding('thunderbolt', options.model.id, false)
        },
        createTinfoilBinding: async (options) => {
          tinfoilArguments.push(options)
          return binding('thunderbolt', options.model.id, false)
        },
      })
      const model = transport === 'direct' ? directModel : confidentialModel
      await runtime.prepare({ model: model.id })

      const relogin = runtime.manage({
        type: 'login',
        presentation: { showVerification: () => {}, showStatus: () => {} },
      })
      await loginStarted.promise
      const staleRejection =
        transport === 'direct'
          ? directArguments[0]!.observeResponse(new Response(null, { status: 401 }))
          : tinfoilArguments[0]!.onStoredSessionRejected()
      releaseLogin.resolve()
      await Promise.all([relogin, staleRejection])

      expect(durableClears).toBe(0)
      expect(runtime.snapshot().thunderbolt.status).toBe('authenticated')
    },
  )

  test.each(['direct', 'confidential'] as const)(
    'retries durable session demotion after the first %s rejection callback fails',
    async (transport) => {
      let demotions = 0
      const base = await createRuntimeHarness({
        initialConfig: config({ activeProviderId: 'thunderbolt' }),
        credential: sessionCredential,
        auth: registeredAuth,
      })
      const directArguments: Parameters<ProviderRuntimeDependencies['createManagedDirectBinding']>[0][] = []
      const tinfoilArguments: Parameters<ProviderRuntimeDependencies['createTinfoilBinding']>[0][] = []
      const { runtime } = await createTestProviderRuntime({
        ...base.dependencies,
        markSessionAuthenticationRequired: async () => {
          demotions += 1
          if (demotions === 1) throw new Error('temporary auth store failure')
        },
        createManagedDirectBinding: async (options) => {
          directArguments.push(options)
          return binding('thunderbolt', options.model.id, false)
        },
        createTinfoilBinding: async (options) => {
          tinfoilArguments.push(options)
          return binding('thunderbolt', options.model.id, false)
        },
      })
      const model = transport === 'direct' ? directModel : confidentialModel
      await runtime.prepare({ model: model.id })
      const rejectSession = () =>
        transport === 'direct'
          ? directArguments[0]!.observeResponse(new Response(null, { status: 401 }))
          : tinfoilArguments[0]!.onStoredSessionRejected()

      await expect(rejectSession()).rejects.toThrow('temporary auth store failure')
      await expect(rejectSession()).resolves.toBeUndefined()

      expect(demotions).toBe(2)
      expect(runtime.snapshot().thunderbolt.status).toBe('authentication required')
    },
  )

  test('rehydrates session success, rejection, and logout from durable auth state across restarts', async () => {
    let authState: CliAuth | null = registeredAuth
    const responses: Parameters<ProviderRuntimeDependencies['createManagedDirectBinding']>[0][] = []
    const { dependencies } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: 'thunderbolt' }),
      credential: sessionCredential,
      auth: registeredAuth,
    })
    const createRuntime = async () =>
      (
        await createTestProviderRuntime({
          ...dependencies,
          loadAuthConfig: async () => authState,
          resolveAccountCredential: async () => (authState?.registration === 'registered' ? sessionCredential : null),
          markSessionAuthenticationRequired: async () => {
            if (authState?.registration === 'registered') {
              authState = { ...authState, registration: 'authentication-required', bearer: null }
            }
          },
          accountActions: {
            ...dependencies.accountActions,
            logout: async () => {
              authState = null
              return 'logged-out'
            },
          },
          createManagedDirectBinding: async (options) => {
            responses.push(options)
            return binding('thunderbolt', options.model.id, false)
          },
        })
      ).runtime

    const successful = await createRuntime()
    await successful.prepare({ model: directModel.id })
    const successObserver = responses.at(-1)?.observeResponse
    if (successObserver) await observeHttpResponse(successObserver, 200)
    expect((await createRuntime()).snapshot().thunderbolt.status).toBe('authenticated')

    const rejected = await createRuntime()
    await rejected.prepare({ model: directModel.id })
    const rejectionObserver = responses.at(-1)?.observeResponse
    if (rejectionObserver) await observeHttpResponse(rejectionObserver, 401)
    expect((await createRuntime()).snapshot().thunderbolt.status).toBe('authentication required')

    authState = registeredAuth
    const loggedOut = await createRuntime()
    await loggedOut.manage({
      type: 'logout',
      presentation: { showVerification: () => {}, showStatus: () => {} },
    })
    expect((await createRuntime()).snapshot().thunderbolt.status).toBe('not authenticated')
  })
})

describe('ProviderRuntime migrated BYOK validation', () => {
  test('does not promote a migrated stored key merely because binding construction succeeds', async () => {
    const migrated = profile({
      id: 'migrated-openai',
      label: 'openai',
      provider: 'openai',
      credentialStatus: 'authentication-required',
      apiKey: 'legacy-key',
    })
    const initial = config({ activeProviderId: migrated.id, providers: [migrated] })
    const { runtime, byokArguments, saved } = await createRuntimeHarness({ initialConfig: initial })

    expect(runtime.snapshot().providers[0]?.status).toBe('authentication required')
    await runtime.prepare({})

    expect(byokArguments[0]?.profile).toEqual(migrated)
    expect(saved).toEqual([])
    expect(runtime.snapshot().providers[0]?.status).toBe('authentication required')
  })

  test('does not promote a migrated compatible key merely because binding construction succeeds', async () => {
    const migrated = profile({
      id: 'migrated-compatible',
      label: 'Local',
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'local-model',
      credentialStatus: 'authentication-required',
      apiKey: 'local-key',
    })
    const { runtime, byokArguments, saved } = await createRuntimeHarness({
      initialConfig: config({ activeProviderId: migrated.id, providers: [migrated] }),
    })

    await runtime.prepare({})

    expect(byokArguments[0]?.profile).toEqual(migrated)
    expect(saved).toEqual([])
  })

  test('does not promote an environment credential merely because binding construction succeeds', async () => {
    const migrated = profile({
      id: 'migrated-google',
      label: 'google',
      provider: 'google',
      credentialStatus: 'authentication-required',
      apiKey: null,
    })
    const initial = config({ activeProviderId: migrated.id, providers: [migrated] })
    const { runtime, saved } = await createRuntimeHarness({
      initialConfig: initial,
      byokBinding: (selected) => binding(selected.id, selected.defaultModel, false),
    })

    await runtime.prepare({})

    expect(saved).toEqual([])
    expect(runtime.snapshot().activeProviderId).toBe(migrated.id)
    expect(runtime.snapshot().providers[0]?.status).toBe('authentication required')
  })

  test('keeps stored-key compatible and keyless failures active and authentication-required', async () => {
    for (const migrated of [
      profile({
        id: 'migrated-compatible',
        label: 'compat',
        provider: 'openai-compat',
        baseUrl: 'http://localhost:11434/v1',
        credentialStatus: 'authentication-required',
      }),
      profile({
        id: 'migrated-keyless',
        label: 'google',
        provider: 'google',
        apiKey: null,
        credentialStatus: 'authentication-required',
      }),
    ]) {
      const initial = config({ activeProviderId: migrated.id, providers: [migrated] })
      const { dependencies, saved } = await createRuntimeHarness({ initialConfig: initial })
      const { runtime: failingRuntime } = await createTestProviderRuntime({
        ...dependencies,
        createByokBinding: async () => {
          throw runtimeError('authentication-required', 'Repair this profile or provide its dedicated environment key.')
        },
      })

      await expect(failingRuntime.prepare({})).rejects.toMatchObject({ code: 'authentication-required' })
      expect(saved).toEqual([])
      expect(failingRuntime.snapshot().activeProviderId).toBe(migrated.id)
      expect(failingRuntime.snapshot().providers[0]?.status).toBe('authentication required')
    }
  })
})
