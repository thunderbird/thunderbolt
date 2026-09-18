/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Api, Model } from '@earendil-works/pi-ai'
import { describe, expect, test } from 'bun:test'
import { bundledManagedCatalog } from './catalog.ts'
import type {
  ByokProfile,
  CliConfig,
  PreparedPiBinding,
  ProviderCommand,
  ProviderManagerIO,
  ProviderManagerItem,
  ProviderRuntime,
  ProviderSnapshot,
} from './types.ts'
import { providerRuntimeError } from './types.ts'
import { createProviderManager, runProviderManager } from './manager.ts'
import { createProviderStageContext } from './provider-stage.ts'
import type { ProviderRuntimeDependencies } from './runtime.ts'
import { createTestProviderRuntime } from './test-fixtures.ts'

const byokId = 'byok-work'
const inactiveByokId = 'byok-personal'
const byokProfile: ByokProfile = {
  id: byokId,
  label: 'Work OpenAI',
  provider: 'openai',
  defaultModel: 'gpt-old',
  apiKey: 'old-key',
  credentialStatus: 'authentication-required',
}
const snapshot = (activeProviderId: string | null = byokId): ProviderSnapshot => ({
  revision: 0,
  activeProviderId,
  thunderbolt: {
    status: 'not authenticated',
    defaultModelId: bundledManagedCatalog.defaultModelId,
    models: bundledManagedCatalog.data.map(({ id, model, name, description }) => ({
      id,
      label: name,
      description: `${model} — ${description}`,
    })),
  },
  providers: [
    {
      id: byokId,
      label: byokProfile.label,
      provider: byokProfile.provider,
      status: 'authentication required',
      defaultModel: byokProfile.defaultModel,
      models: [
        { id: byokProfile.defaultModel, label: byokProfile.defaultModel },
        { id: 'gpt-new', label: 'gpt-new' },
      ],
    },
    {
      id: inactiveByokId,
      label: 'Personal Google',
      provider: 'google',
      status: 'authenticated',
      defaultModel: 'gemini-old',
      models: [
        { id: 'gemini-old', label: 'gemini-old' },
        { id: 'gemini-new', label: 'gemini-new' },
      ],
    },
  ],
})

const preparedBinding = (providerId: string): PreparedPiBinding => ({
  providerId,
  wireModel: 'validated-model',
  persistsCredentialStatus: false,
  piModel: { provider: providerId, id: 'validated-model' } as Model<Api>,
  install: () => {},
  attach: () => () => {},
  observePromptError: async () => {},
  dispose: async () => {},
})

const confirmedLogoutPersistenceFailure = (): Error & {
  readonly code: 'persistence-failed'
  readonly remoteLogoutConfirmed: true
} =>
  Object.assign(
    providerRuntimeError(
      'persistence-failed',
      'Remote logout succeeded, but local authentication state could not be cleared.',
    ),
    { remoteLogoutConfirmed: true as const },
  )

const validatedModels = async () => ({ source: 'live' as const, ids: ['validated-model'], authenticated: true })
const createValidatedManager = () => {
  const providerStage = createProviderStageContext()
  return {
    providerStage,
    manager: createProviderManager({ listByokModels: validatedModels, providerStage }),
  }
}

const scriptedIO = (options: {
  readonly choices?: readonly string[]
  readonly texts?: readonly (string | null)[]
  readonly secrets?: readonly (string | null)[]
}) => {
  const choices = [...(options.choices ?? [])]
  const texts = [...(options.texts ?? [])]
  const secrets = [...(options.secrets ?? [])]
  const menus: { title: string; items: readonly ProviderManagerItem[] }[] = []
  const writes: string[] = []
  const verifications: Parameters<ProviderManagerIO['showVerification']>[0][] = []
  const statuses: Parameters<ProviderManagerIO['showStatus']>[] = []
  const io: ProviderManagerIO = {
    choose: async (title, items) => {
      menus.push({ title, items })
      return choices.shift() ?? null
    },
    readText: async () => texts.shift() ?? null,
    readSecret: async () => secrets.shift() ?? null,
    write: (text) => writes.push(text),
    showVerification: (value) => verifications.push(value),
    showStatus: (...value) => statuses.push(value),
  }
  return { io, menus, writes, verifications, statuses }
}

const runtimeHarness = (
  initialSnapshot: ProviderSnapshot,
  manageOverride?: (command: ProviderCommand) => Promise<ProviderSnapshot>,
) => {
  const managed: ProviderCommand[] = []
  const prepared: Parameters<ProviderRuntime['prepare']>[0][] = []
  let disposals = 0
  const runtime: ProviderRuntime = {
    snapshot: () => initialSnapshot,
    manage: async (command) => {
      managed.push(command)
      return manageOverride?.(command) ?? initialSnapshot
    },
    prepare: async (selection) => {
      prepared.push(selection)
      const result = preparedBinding(selection.providerId ?? byokId)
      return {
        ...result,
        dispose: async () => {
          disposals += 1
        },
      }
    },
  }
  return { runtime, managed, prepared, disposals: () => disposals }
}

describe('provider manager deferred outcomes', () => {
  test('uses the live BYOK owner for models when persisted active remains Thunderbolt', async () => {
    const { io, menus } = scriptedIO({ choices: ['gpt-new'] })
    const { runtime, managed } = runtimeHarness(snapshot('thunderbolt'))
    const manager = createProviderManager({
      listByokModels: validatedModels,
      providerStage: createProviderStageContext(),
    })

    const outcome = await manager(io, runtime, 'models', undefined, () => byokId)

    expect(menus[0]?.items.some(({ id }) => id === 'gpt-new')).toBeTrue()
    expect(outcome).toEqual({
      kind: 'switch',
      selection: { providerId: byokId, model: 'gpt-new' },
      persist: { type: 'select-model', providerId: byokId, model: 'gpt-new' },
      forceReplace: false,
    })
    expect(managed).toEqual([])
  })

  test('uses the live Thunderbolt owner for models when persisted active remains BYOK', async () => {
    const selectedModel = bundledManagedCatalog.data[1]
    if (!selectedModel) throw new Error('managed catalog fixture needs two models')
    const { io, menus } = scriptedIO({ choices: [selectedModel.id] })
    const initial = snapshot(byokId)
    const { runtime, managed } = runtimeHarness(initial, async (command) =>
      command.type === 'load-models' ? initial : initial,
    )
    const manager = createProviderManager({
      listByokModels: validatedModels,
      providerStage: createProviderStageContext(),
    })

    const outcome = await manager(io, runtime, 'models', undefined, () => 'thunderbolt')

    expect(menus[0]?.items).toHaveLength(bundledManagedCatalog.data.length)
    expect(outcome).toEqual({
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: selectedModel.id },
      persist: { type: 'select-model', providerId: 'thunderbolt', model: selectedModel.id },
      forceReplace: false,
    })
    expect(managed).toEqual([{ type: 'load-models', providerId: 'thunderbolt' }])
  })

  test('returns the exact provider switch without persisting it early', async () => {
    const { io } = scriptedIO({ choices: [byokId, 'use'] })
    const { runtime, managed } = runtimeHarness(snapshot(inactiveByokId))

    const providerSwitch = await runProviderManager(io, runtime, 'providers')

    expect(providerSwitch).toEqual({
      kind: 'switch',
      selection: { providerId: byokId },
      persist: { type: 'use', providerId: byokId },
      forceReplace: false,
    })
    expect(managed).toEqual([])
  })

  test('returns the exact model switch without persisting it early', async () => {
    const { io } = scriptedIO({ choices: ['gpt-old'] })
    const { runtime, managed } = runtimeHarness(snapshot(byokId))

    const modelSwitch = await runProviderManager(io, runtime, 'models')

    expect(modelSwitch).toEqual({
      kind: 'switch',
      selection: { providerId: byokId, model: 'gpt-old' },
      persist: { type: 'select-model', providerId: byokId, model: 'gpt-old' },
      forceReplace: false,
    })
    expect(managed).toEqual([])
  })

  test('lists the complete managed catalog and persists its stable UUID instead of free text', async () => {
    const chosen = bundledManagedCatalog.data[1]
    if (!chosen) throw new Error('managed catalog fixture needs two models')
    const managedSnapshot: ProviderSnapshot = {
      ...snapshot('thunderbolt'),
      thunderbolt: {
        status: 'authenticated',
        defaultModelId: bundledManagedCatalog.defaultModelId,
        models: snapshot('thunderbolt').thunderbolt.models,
      },
    }
    const { io, menus } = scriptedIO({ choices: [chosen.id] })
    const { runtime, managed } = runtimeHarness(managedSnapshot)

    const outcome = await runProviderManager(io, runtime, 'models')

    expect(menus[0]?.items).toHaveLength(bundledManagedCatalog.data.length)
    expect(menus[0]?.items[1]).toMatchObject({ id: chosen.id, label: chosen.name })
    expect(outcome).toEqual({
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: chosen.id },
      persist: { type: 'select-model', providerId: 'thunderbolt', model: chosen.id },
      forceReplace: false,
    })
    expect(managed).toEqual([{ type: 'load-models', providerId: 'thunderbolt' }])
  })

  test('lists built-in upstream models for the active BYOK provider', async () => {
    const { io, menus } = scriptedIO({ choices: ['gpt-old'] })
    const { runtime } = runtimeHarness(snapshot(byokId))

    await runProviderManager(io, runtime, 'models')

    expect(menus[0]?.title).toBe('Models')
    expect(menus[0]?.items.length).toBeGreaterThan(1)
    expect(menus[0]?.items.some(({ id }) => id === 'gpt-old')).toBe(true)
  })

  test('returns the exact active repair and keeps replacement credentials out of early persistence', async () => {
    const { io, writes } = scriptedIO({ choices: [byokId, 'repair'], secrets: ['replacement-key'] })
    const { runtime, managed, prepared } = runtimeHarness(snapshot(byokId))
    const { manager } = createValidatedManager()

    const activeRepair = await manager(io, runtime, 'providers')

    expect(activeRepair).toEqual({
      kind: 'switch',
      selection: { providerId: byokId },
      persist: { type: 'commit-staged-byok', providerId: byokId, activate: false },
      forceReplace: true,
    })
    expect(JSON.stringify(activeRepair)).not.toContain('replacement-key')
    expect(managed).toEqual([])
    expect(prepared).toEqual([])
    expect(writes.join('')).not.toContain('replacement-key')
  })

  test('scopes an active compatible repair key to the replacement endpoint during validation', async () => {
    const compatibleSnapshot: ProviderSnapshot = {
      ...snapshot('byok-compatible'),
      providers: [
        {
          id: 'byok-compatible',
          label: 'Compatible',
          provider: 'openai-compat',
          status: 'authentication required',
          defaultModel: 'custom-model',
          models: [{ id: 'custom-model', label: 'custom-model' }],
        },
      ],
    }
    const { io } = scriptedIO({
      choices: ['byok-compatible', 'repair'],
      texts: ['https://replacement.example/v1'],
      secrets: ['replacement-key'],
    })
    const { runtime } = runtimeHarness(compatibleSnapshot)
    const providerStage = createProviderStageContext()

    const result = await createProviderManager({
      listByokModels: async (options) => {
        expect(options).toMatchObject({
          provider: 'openai-compat',
          baseUrl: 'https://replacement.example/v1',
          apiKey: 'replacement-key',
        })
        return { source: 'live', ids: ['custom-model'], authenticated: true }
      },
      providerStage,
    })(io, runtime, 'providers')

    expect(result).toEqual({
      kind: 'switch',
      selection: { providerId: 'byok-compatible' },
      persist: { type: 'commit-staged-byok', providerId: 'byok-compatible', activate: false },
      forceReplace: true,
    })
    expect(JSON.stringify(result)).not.toContain('replacement-key')
  })

  test('refreshes the live binding when login starts with Thunderbolt active', async () => {
    const selectedModel = bundledManagedCatalog.data[1]
    if (!selectedModel) throw new Error('managed catalog fixture needs two models')
    const { io, menus, verifications, statuses } = scriptedIO({ choices: [selectedModel.id] })
    const initial = snapshot('thunderbolt')
    const { runtime, managed } = runtimeHarness(initial, async (command) => {
      if (command.type !== 'login') throw new Error('expected login')
      command.presentation.showVerification({
        verificationUrl: 'https://accounts.example/activate',
        userCode: 'ABCD-EFGH',
      })
      command.presentation.showStatus('waiting', 'Waiting for approval…')
      command.presentation.showStatus('success', 'Login successful.')
      return {
        ...initial,
        thunderbolt: {
          ...initial.thunderbolt,
          status: 'authenticated',
        },
      }
    })

    const activeThunderboltLogin = await runProviderManager(io, runtime, 'login')

    expect(activeThunderboltLogin).toEqual({
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: selectedModel.id },
      persist: { type: 'select-model', providerId: 'thunderbolt', model: selectedModel.id },
      forceReplace: true,
    })
    expect(managed).toHaveLength(1)
    expect(managed[0]).toMatchObject({ type: 'login', presentation: io })
    expect(verifications).toEqual([{ verificationUrl: 'https://accounts.example/activate', userCode: 'ABCD-EFGH' }])
    expect(statuses).toEqual([
      ['waiting', 'Waiting for approval…'],
      ['success', 'Login successful.'],
    ])
    expect(menus.at(-1)?.items).toHaveLength(bundledManagedCatalog.data.length)
  })

  test('activates Thunderbolt when standalone login starts without an active provider', async () => {
    const selectedModel = bundledManagedCatalog.data[1]
    if (!selectedModel) throw new Error('managed catalog fixture needs two models')
    const { io } = scriptedIO({ choices: [selectedModel.id] })
    const { runtime, managed } = runtimeHarness(snapshot(null))

    const outcome = await runProviderManager(io, runtime, 'login')

    expect(outcome).toEqual({
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: selectedModel.id },
      persist: { type: 'use', providerId: 'thunderbolt', model: selectedModel.id },
      forceReplace: true,
    })
    expect(managed).toHaveLength(1)
    expect(managed[0]).toMatchObject({ type: 'login', presentation: io })
  })

  test('carries a manager cancellation signal on the account command', async () => {
    const controller = new AbortController()
    const { io } = scriptedIO({})
    const promptToOpenBrowser = async (): Promise<void> => {}
    const presentationIO = { ...io, promptToOpenBrowser }
    const { runtime, managed } = runtimeHarness(snapshot('thunderbolt'))

    await runProviderManager(presentationIO, runtime, 'login', controller.signal)

    expect(managed[0]).toMatchObject({ type: 'login', presentation: { promptToOpenBrowser }, signal: controller.signal })
  })

  test('carries cancellation through the first-run account login path', async () => {
    const controller = new AbortController()
    const { io } = scriptedIO({ choices: ['thunderbolt-account'] })
    const { runtime, managed } = runtimeHarness(snapshot(null))

    await runProviderManager(io, runtime, 'first-run', controller.signal)

    expect(managed[0]).toMatchObject({ type: 'login', signal: controller.signal })
  })

  test('carries cancellation through first-run BYOK model listing', async () => {
    const controller = new AbortController()
    const { io } = scriptedIO({
      choices: ['provider-api-key', 'builtin:openai', 'validated-model'],
      texts: ['Work OpenAI'],
      secrets: ['openai-key'],
    })
    const { runtime } = runtimeHarness(snapshot(null))
    const providerStage = createProviderStageContext()
    const manager = createProviderManager({
      listByokModels: async (_options, signal?: AbortSignal) => {
        if (signal !== controller.signal) throw new Error('BYOK listing did not receive the manager signal.')
        return validatedModels()
      },
      providerStage,
    })

    const outcome = await manager(io, runtime, 'first-run', controller.signal)

    expect(outcome.kind).toBe('switch')
  })

  test('carries cancellation through BYOK repair model listing', async () => {
    const controller = new AbortController()
    const { io } = scriptedIO({ choices: [byokId, 'repair'], secrets: ['replacement-key'] })
    const { runtime } = runtimeHarness(snapshot(byokId))
    const providerStage = createProviderStageContext()
    const manager = createProviderManager({
      listByokModels: async (_options, signal?: AbortSignal) => {
        if (signal !== controller.signal) throw new Error('BYOK repair listing did not receive the manager signal.')
        return validatedModels()
      },
      providerStage,
    })

    const outcome = await manager(io, runtime, 'providers', controller.signal)

    expect(outcome.kind).toBe('switch')
  })

  test('passes login presentation errors through the same IO adapter', async () => {
    const { io, statuses } = scriptedIO({})
    const initial = snapshot('thunderbolt')
    const expectedError = new Error('authorization expired')
    const { runtime } = runtimeHarness(initial, async (command) => {
      if (command.type !== 'login') throw new Error('expected login')
      command.presentation.showStatus('error', expectedError.message)
      throw expectedError
    })

    await expect(runProviderManager(io, runtime, 'login')).rejects.toBe(expectedError)
    expect(statuses).toEqual([['error', 'authorization expired']])
  })

  test('returns deactivate for active Thunderbolt logout but leaves an active BYOK profile live', async () => {
    const thunderboltIO = scriptedIO({})
    const thunderbolt = runtimeHarness(snapshot('thunderbolt'))

    const activeThunderboltLogout = await runProviderManager(thunderboltIO.io, thunderbolt.runtime, 'logout')

    expect(activeThunderboltLogout).toEqual({ kind: 'deactivate', persist: { type: 'clear-active' } })
    expect(thunderbolt.managed).toHaveLength(1)
    expect(thunderbolt.managed[0]).toMatchObject({ type: 'logout', presentation: thunderboltIO.io })

    const byokIO = scriptedIO({})
    const byok = runtimeHarness(snapshot(byokId))
    const byokActiveLogout = await runProviderManager(byokIO.io, byok.runtime, 'logout')
    expect(byokActiveLogout).toEqual({ kind: 'handled' })
    expect(byok.managed).toHaveLength(1)
    expect(byok.managed[0]).toMatchObject({ type: 'logout', presentation: byokIO.io })
  })

  test('returns an irreversible deactivate outcome when remote logout succeeded but local auth clear failed', async () => {
    const failure = confirmedLogoutPersistenceFailure()
    const { runtime } = runtimeHarness(snapshot('thunderbolt'), async (command) => {
      if (command.type === 'logout') throw failure
      return snapshot('thunderbolt')
    })

    const outcome = await runProviderManager(scriptedIO({}).io, runtime, 'logout')

    expect(outcome).toEqual({
      kind: 'deactivate',
      persist: { type: 'clear-active' },
      failure,
    })
  })

  test('logs out the account according to the live override without changing the saved owner', async () => {
    const savedThunderbolt = runtimeHarness(snapshot('thunderbolt'))
    const liveByokManager = createProviderManager({
      listByokModels: validatedModels,
      providerStage: createProviderStageContext(),
    })

    expect(await liveByokManager(scriptedIO({}).io, savedThunderbolt.runtime, 'logout', undefined, () => byokId)).toEqual({
      kind: 'handled',
    })

    const savedByok = runtimeHarness(snapshot(byokId))
    const liveThunderboltManager = createProviderManager({
      listByokModels: validatedModels,
      providerStage: createProviderStageContext(),
    })

    expect(
      await liveThunderboltManager(scriptedIO({}).io, savedByok.runtime, 'logout', undefined, () => 'thunderbolt'),
    ).toEqual({
      kind: 'deactivate',
      persist: null,
    })
    expect(savedByok.managed).toHaveLength(1)
    expect(savedByok.managed[0]).toMatchObject({ type: 'logout' })
  })

  test('defers active removal and persists inactive removal exactly once', async () => {
    const activeIO = scriptedIO({ choices: [byokId, 'remove'] })
    const active = runtimeHarness(snapshot(byokId))
    const activeRemoval = await runProviderManager(activeIO.io, active.runtime, 'providers')
    expect(activeRemoval).toEqual({
      kind: 'deactivate',
      persist: { type: 'remove-byok', providerId: byokId },
    })
    expect(active.managed).toEqual([])

    const inactiveIO = scriptedIO({ choices: [inactiveByokId, 'remove'] })
    const inactive = runtimeHarness(snapshot(byokId))
    const inactiveRemoval = await runProviderManager(inactiveIO.io, inactive.runtime, 'providers')
    expect(inactiveRemoval).toEqual({ kind: 'handled' })
    expect(inactive.managed).toEqual([{ type: 'remove-byok', providerId: inactiveByokId }])
  })

  test('validates and disposes an inactive repair before persisting it once', async () => {
    const { io } = scriptedIO({ choices: [inactiveByokId, 'repair'], secrets: ['new-google-key'] })
    const state = snapshot(byokId)
    const { runtime, managed, prepared, disposals } = runtimeHarness(state)
    const { manager } = createValidatedManager()

    const result = await manager(io, runtime, 'providers')

    expect(result).toEqual({ kind: 'handled' })
    expect(prepared).toEqual([{ providerId: inactiveByokId }])
    expect(disposals()).toBe(1)
    expect(managed).toEqual([{ type: 'commit-staged-byok', providerId: inactiveByokId, activate: false }])
    expect(JSON.stringify({ prepared, managed })).not.toContain('new-google-key')
  })
})

describe('provider manager menus', () => {
  test('lists structural Thunderbolt first, then BYOK profiles with last-known statuses', async () => {
    const { io, menus } = scriptedIO({ choices: [] })
    const { runtime } = runtimeHarness(snapshot(byokId))

    expect(await runProviderManager(io, runtime, 'providers')).toEqual({ kind: 'handled' })

    expect(menus[0]).toEqual({
      title: 'Providers',
      items: [
        { id: 'thunderbolt', label: 'Thunderbolt', description: 'not authenticated' },
        { id: byokId, label: 'Work OpenAI', description: 'openai — authentication required' },
        { id: inactiveByokId, label: 'Personal Google', description: 'google — authenticated' },
        { id: 'add-byok', label: 'Add provider API key' },
      ],
    })
  })

  test('first-run account choice logs in and returns one deferred activation', async () => {
    const { io } = scriptedIO({ choices: ['thunderbolt-account'] })
    const { runtime, managed } = runtimeHarness(snapshot(null))

    const result = await runProviderManager(io, runtime, 'first-run')

    expect(result).toEqual({
      kind: 'switch',
      selection: { providerId: 'thunderbolt', model: snapshot(null).thunderbolt.defaultModelId },
      persist: {
        type: 'use',
        providerId: 'thunderbolt',
        model: snapshot(null).thunderbolt.defaultModelId,
      },
      forceReplace: true,
    })
    expect(managed).toHaveLength(1)
    expect(managed[0]).toMatchObject({ type: 'login', presentation: io })
  })

  test('successful first-run BYOK add persists the profile as active across a runtime restart', async () => {
    const { manager, providerStage } = createValidatedManager()
    let persisted: CliConfig = {
      version: 3,
      activeProviderId: null,
      thunderbolt: { defaultModelId: bundledManagedCatalog.defaultModelId },
      providers: [],
    }
    const dependencies: ProviderRuntimeDependencies = {
      loadConfig: async () => persisted,
      loadAuthConfig: async () => null,
      saveConfig: async (next) => {
        persisted = next
      },
      resolveAccountCredential: async () => null,
      accountActions: {
        login: async () => {
          throw new Error('unexpected login')
        },
        logout: async () => {
          throw new Error('unexpected logout')
        },
      },
      loadCatalog: async () => bundledManagedCatalog,
      ensureRegisteredSession: async (credential) => credential,
      markSessionAuthenticationRequired: async () => {},
      metadata: { deviceName: 'Test CLI' },
      createByokBinding: async (profile) => preparedBinding(profile.id),
      createManagedDirectBinding: async () => preparedBinding('thunderbolt'),
      createTinfoilBinding: async () => preparedBinding('thunderbolt'),
      environment: {},
      providerStage,
    }
    const { runtime } = await createTestProviderRuntime(dependencies)
    const { io } = scriptedIO({
      choices: ['provider-api-key', 'builtin:openai', 'gpt-5.6-sol'],
      texts: ['Work OpenAI'],
      secrets: ['openai-key'],
    })

    const outcome = await manager(io, runtime, 'first-run')
    if (outcome.kind !== 'switch') throw new Error(`expected switch, got ${outcome.kind}`)
    const stagedProviderId = outcome.selection.providerId
    if (stagedProviderId === undefined) throw new Error('expected a staged provider id')
    expect(outcome.persist).toEqual({
      type: 'commit-staged-byok',
      providerId: stagedProviderId,
      activate: true,
    })
    expect(JSON.stringify(outcome)).not.toContain('openai-key')
    const prepared = await runtime.prepare(outcome.selection)
    await runtime.manage(outcome.persist)
    await prepared.dispose()

    expect(persisted.providers).toHaveLength(1)
    expect(persisted.providers[0]).toMatchObject({
      label: 'Work OpenAI',
      provider: 'openai',
      defaultModel: 'gpt-5.6-sol',
      apiKey: 'openai-key',
      credentialStatus: 'authenticated',
    })
    expect(persisted.activeProviderId).toBe(persisted.providers[0]?.id)

    const { runtime: restarted } = await createTestProviderRuntime(dependencies)
    expect(restarted.snapshot().activeProviderId).toBe(persisted.providers[0]?.id)
  })

  test('keeps a future listed model in memory until the single atomic persistence succeeds', async () => {
    const emptyConfig: CliConfig = {
      version: 3,
      activeProviderId: null,
      thunderbolt: { defaultModelId: bundledManagedCatalog.defaultModelId },
      providers: [],
    }
    const persistenceFailure = new Error('disk full')
    const providerStage = createProviderStageContext()
    const { runtime } = await createTestProviderRuntime({
      loadConfig: async () => emptyConfig,
      loadAuthConfig: async () => null,
      saveConfig: async () => {
        throw persistenceFailure
      },
      resolveAccountCredential: async () => null,
      accountActions: {
        login: async () => {
          throw new Error('unexpected login')
        },
        logout: async () => {
          throw new Error('unexpected logout')
        },
      },
      loadCatalog: async () => bundledManagedCatalog,
      ensureRegisteredSession: async (credential) => credential,
      markSessionAuthenticationRequired: async () => {},
      metadata: { deviceName: 'Test CLI' },
      createByokBinding: async (profile) => preparedBinding(profile.id),
      createManagedDirectBinding: async () => preparedBinding('thunderbolt'),
      createTinfoilBinding: async () => preparedBinding('thunderbolt'),
      environment: {},
      providerStage,
    })
    const manager = createProviderManager({
      listByokModels: async () => ({
        source: 'live',
        ids: ['future-provider-model'],
        authenticated: true,
      }),
      providerStage,
    })
    const { io } = scriptedIO({
      choices: ['provider-api-key', 'builtin:openai', 'future-provider-model'],
      texts: ['Future OpenAI'],
      secrets: ['future-key'],
    })

    const outcome = await manager(io, runtime, 'first-run')
    if (outcome.kind !== 'switch') throw new Error(`expected switch, got ${outcome.kind}`)
    const prepared = await runtime.prepare(outcome.selection)

    await expect(runtime.manage(outcome.persist)).rejects.toMatchObject({
      code: 'persistence-failed',
      message: persistenceFailure.message,
    })
    await prepared.dispose()
    expect(runtime.snapshot().providers).toEqual([])
    expect(runtime.snapshot().activeProviderId).toBeNull()
  })

  test('cancelled model choices are handled without persistence', async () => {
    for (const _model of [null] as const) {
      const { io } = scriptedIO({ choices: [] })
      const { runtime, managed } = runtimeHarness(snapshot(byokId))
      expect(await runProviderManager(io, runtime, 'models')).toEqual({ kind: 'handled' })
      expect(managed).toEqual([])
    }
  })
})
