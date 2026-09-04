/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModels } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, test } from 'bun:test'
import { builtinProviderEnvVars } from '../agent/defaults.ts'
import type { CredentialResponseObserver } from '../agent/credentialed-fetch.ts'
import { builtinProviders } from '../agent/types.ts'
import type { BuiltinProvider } from '../agent/types.ts'
import { createByokBinding } from './byok.ts'
import type { ByokProfile, InvocationSelection } from './types.ts'

const firstCatalogModelId = (provider: BuiltinProvider): string => {
  const model = builtinModels().getModels(provider)[0]
  if (!model) throw new Error(`Pi catalog has no models for ${provider}.`)
  return model.id
}

const builtinProfile = (
  provider: BuiltinProvider,
  overrides: Partial<Extract<ByokProfile, { readonly provider: BuiltinProvider }>> = {},
): Extract<ByokProfile, { readonly provider: BuiltinProvider }> => ({
  id: `profile-${provider}`,
  label: `${provider} profile`,
  provider,
  defaultModel: firstCatalogModelId(provider),
  apiKey: 'stored-key',
  credentialStatus: 'authenticated',
  ...overrides,
})

const openAiCompatProfile = (
  overrides: Partial<Extract<ByokProfile, { readonly provider: 'openai-compat' }>> = {},
): Extract<ByokProfile, { readonly provider: 'openai-compat' }> => ({
  id: 'profile-local',
  label: 'Local model',
  provider: 'openai-compat',
  defaultModel: 'llama3.3',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'stored-key',
  credentialStatus: 'authenticated',
  ...overrides,
})

const prepare = (
  profile: ByokProfile,
  selection: InvocationSelection = {},
  environment: Readonly<Record<string, string | undefined>> = {},
  observeResponse: CredentialResponseObserver = () => {},
) => createByokBinding(profile, selection, environment, observeResponse)

const expectCredential = async (
  profile: ByokProfile,
  selection: InvocationSelection,
  environment: Readonly<Record<string, string | undefined>>,
  persistsCredentialStatus: boolean,
): Promise<void> => {
  const binding = await prepare(profile, selection, environment)
  expect(binding.persistsCredentialStatus).toBe(persistsCredentialStatus)
  expect(JSON.stringify(binding.piModel)).not.toContain('stored-key')
  await binding.dispose()
}

describe('createByokBinding built-in profiles', () => {
  test('prepares every curated provider under its stable profile id', async () => {
    for (const builtinProvider of builtinProviders) {
      const profile = builtinProfile(builtinProvider)
      const binding = await prepare(profile)
      const installed = createModels()

      binding.install(installed)

      expect(binding).toMatchObject({
        providerId: profile.id,
        wireModel: profile.defaultModel,
        persistsCredentialStatus: true,
      })
      expect(binding.piModel).toMatchObject({ id: profile.defaultModel, provider: profile.id })
      expect(installed.getModel(profile.id, profile.defaultModel)).toBe(binding.piModel)
      expect(installed.getProvider(builtinProvider)).toBeUndefined()

      await binding.dispose()
      await binding.dispose()
    }
  })

  test('uses an explicit flag before the dedicated environment and stored key', async () => {
    const profile = builtinProfile('openai')
    await expectCredential(profile, { apiKey: 'flag-key' }, { OPENAI_API_KEY: 'environment-key' }, false)
  })

  test('uses every built-in provider dedicated environment key before its stored key', async () => {
    for (const builtinProvider of builtinProviders) {
      const envName = builtinProviderEnvVars[builtinProvider][0]
      if (!envName) throw new Error(`No dedicated environment key for ${builtinProvider}.`)
      await expectCredential(
        builtinProfile(builtinProvider),
        {},
        { [envName]: `${builtinProvider}-environment-key` },
        false,
      )
    }
  })

  test('uses the stored key when no process-only credential is present', async () => {
    await expectCredential(builtinProfile('anthropic'), {}, {}, true)
  })

  test('rejects every keyless built-in profile without selecting another producer', async () => {
    for (const builtinProvider of builtinProviders) {
      const profile = builtinProfile(builtinProvider, { apiKey: null })
      await expect(prepare(profile)).rejects.toMatchObject({
        code: 'authentication-required',
      })
    }
  })

  test('allows a stored authentication-required credential to prove itself on the next real request', async () => {
    const profile = builtinProfile('anthropic', { credentialStatus: 'authentication-required' })
    const binding = await prepare(profile)

    expect(binding.persistsCredentialStatus).toBeTrue()
  })

  test('keeps multiple profiles for the same built-in provider distinct', async () => {
    const modelId = firstCatalogModelId('anthropic')
    const first = await prepare(builtinProfile('anthropic', { id: 'anthropic-work', defaultModel: modelId }))
    const second = await prepare(builtinProfile('anthropic', { id: 'anthropic-personal', defaultModel: modelId }))
    const installed = createModels()

    first.install(installed)
    second.install(installed)

    expect(installed.getProviders().map(({ id }) => id)).toEqual(['anthropic-work', 'anthropic-personal'])
    expect(first.piModel.provider).toBe('anthropic-work')
    expect(second.piModel.provider).toBe('anthropic-personal')
  })

  test('uses the selected upstream model without changing its public id', async () => {
    const profile = builtinProfile('google')
    const alternate = builtinModels()
      .getModels('google')
      .find(({ id }) => id !== profile.defaultModel)
    if (!alternate) throw new Error('Pi catalog needs two Google models for this test.')

    const binding = await prepare(profile, { model: alternate.id })

    expect(binding.wireModel).toBe(alternate.id)
    expect(binding.piModel).toMatchObject({ id: alternate.id, provider: profile.id })
  })

  test('prepares a newly listed built-in model absent from the bundled catalog', async () => {
    const binding = await prepare(builtinProfile('mistral'), { model: 'future-mistral-model' })
    expect(binding.piModel).toMatchObject({ id: 'future-mistral-model', provider: 'profile-mistral' })
  })

  test('requires repair metadata before preparing an unknown mixed-protocol Fireworks model', async () => {
    const unresolved: Extract<ByokProfile, { readonly provider: 'fireworks' }> = {
      ...builtinProfile('fireworks'),
      provider: 'fireworks',
      defaultModel: 'future-fireworks-model',
      credentialStatus: 'authentication-required',
    }

    await expect(prepare(unresolved)).rejects.toMatchObject({
      code: 'authentication-required',
      message: expect.stringMatching(/repair.*API format/i),
    })

    for (const modelApi of ['anthropic-messages', 'openai-completions'] as const) {
      const binding = await prepare({ ...unresolved, modelApi })
      expect(binding.piModel).toMatchObject({ id: unresolved.defaultModel, api: modelApi })
    }
  })

  test('derives a known Fireworks model protocol and base URL from Pi despite stale profile metadata', async () => {
    const source = builtinModels().getModels('fireworks')
    const anthropic = source.find(({ api }) => api === 'anthropic-messages')
    const openai = source.find(({ api }) => api === 'openai-completions')
    if (!anthropic || !openai) throw new Error('Fireworks fixture must expose both protocols')

    for (const [model, staleApi] of [
      [anthropic, 'openai-completions'],
      [openai, 'anthropic-messages'],
    ] as const) {
      const prepared = await prepare({
        ...builtinProfile('fireworks'),
        provider: 'fireworks',
        defaultModel: model.id,
        modelApi: staleApi,
      })

      expect(prepared.piModel).toMatchObject({ id: model.id, api: model.api, baseUrl: model.baseUrl })
    }
  })
})

describe('createByokBinding openai-compat profiles', () => {
  test('uses flag, dedicated environment, then stored credentials in order', async () => {
    const profile = openAiCompatProfile()
    await expectCredential(
      profile,
      { apiKey: 'flag-key' },
      { THUNDERBOLT_OPENAI_COMPAT_KEY: 'environment-key' },
      false,
    )
    await expectCredential(profile, {}, { THUNDERBOLT_OPENAI_COMPAT_KEY: 'environment-key' }, false)
    await expectCredential(profile, {}, {}, true)
  })

  test('scopes a stored key to the exact saved endpoint', async () => {
    const profile = openAiCompatProfile()
    const binding = await prepare(profile, { baseUrl: profile.baseUrl })

    expect(binding.persistsCredentialStatus).toBeTrue()
    expect(binding.piModel.baseUrl).toBe(profile.baseUrl)

    await expect(prepare(profile, { baseUrl: 'https://other.example/v1' })).rejects.toThrow(
      /stored key.*other\.example.*--api-key.*THUNDERBOLT_OPENAI_COMPAT_KEY/i,
    )
  })

  test('allows a flag or dedicated environment key at an overridden endpoint', async () => {
    const profile = openAiCompatProfile()
    const endpoint = 'https://other.example/v1'
    const flagged = await prepare(profile, { baseUrl: endpoint, apiKey: 'flag-key' })
    const fromEnvironment = await prepare(
      profile,
      { baseUrl: endpoint },
      { THUNDERBOLT_OPENAI_COMPAT_KEY: 'environment-key' },
    )

    expect(flagged.persistsCredentialStatus).toBeFalse()
    expect(flagged.piModel).toMatchObject({ provider: profile.id, baseUrl: endpoint })
    expect(fromEnvironment.persistsCredentialStatus).toBeFalse()
    expect(fromEnvironment.piModel).toMatchObject({ provider: profile.id, baseUrl: endpoint })
  })

  test('rejects a keyless custom endpoint with stable authentication guidance', async () => {
    await expect(prepare(openAiCompatProfile({ apiKey: null }))).rejects.toMatchObject({
      code: 'authentication-required',
    })
  })

  test('keeps multiple custom endpoints isolated under their profile ids', async () => {
    const firstProfile = openAiCompatProfile({ id: 'local-a', baseUrl: 'http://localhost:11434/v1' })
    const secondProfile = openAiCompatProfile({ id: 'local-b', baseUrl: 'http://127.0.0.1:1234/v1' })
    const first = await prepare(firstProfile)
    const second = await prepare(secondProfile)
    const installed = createModels()

    first.install(installed)
    second.install(installed)

    expect(installed.getProvider('local-a')?.baseUrl).toBe(firstProfile.baseUrl)
    expect(installed.getProvider('local-b')?.baseUrl).toBe(secondProfile.baseUrl)
    expect(installed.getModels().map(({ provider }) => provider)).toEqual(['local-a', 'local-b'])
  })
})
