/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Typed, versioned persistence for CLI provider profiles. */

import { randomUUID } from 'node:crypto'
import { builtinModels as piBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { defaultModelId } from '../../../shared/defaults/models.ts'
import { isBuiltinProvider } from '../agent/types.ts'
import type { BuiltinProvider } from '../agent/types.ts'
import { hasExactKeys, isNonblankString, isRecord, parseJson, uuidPattern } from '../lib/json.ts'
import { readFileOrNull, withSecureFileLock, writeSecureFile } from '../lib/secure-fs.ts'
import { createStateError } from '../lib/state-error.ts'
import { configPath } from '../paths.ts'
import type { ByokProfile, CliConfig as CliConfigV3 } from '../provider-runtime/types.ts'

export type { CliConfig } from '../provider-runtime/types.ts'

/** Historical single-provider file shape accepted only for on-disk migration. */
export type LegacyCliConfig =
  | { readonly provider: 'openai-compat'; readonly model: string; readonly apiKey?: string; readonly baseUrl: string }
  | { readonly provider: BuiltinProvider; readonly model: string; readonly apiKey?: string }

type ParsedConfig = { readonly config: CliConfigV3; readonly migrated: boolean }
const observedConfigContents = new Map<string, string | null>()

const baseProfileKeys = ['id', 'label', 'defaultModel', 'apiKey', 'credentialStatus', 'provider'] as const
const isV3CredentialStatus = (status: unknown): status is ByokProfile['credentialStatus'] =>
  status === 'authenticated' || status === 'not-authenticated' || status === 'authentication-required'

/** Reconstructs one strict versioned BYOK profile from untrusted JSON. */
const parseByokProfile = (value: unknown): ByokProfile | null => {
  if (!isRecord(value)) return null
  if (!isNonblankString(value.id) || value.id === 'thunderbolt') return null
  if (!isNonblankString(value.label) || !isNonblankString(value.defaultModel)) return null
  if (!isNonblankString(value.provider)) return null
  if (value.apiKey !== null && typeof value.apiKey !== 'string') return null
  if (!isV3CredentialStatus(value.credentialStatus)) return null

  if (isBuiltinProvider(value.provider)) {
    const modelApi = value.modelApi
    if (value.provider === 'fireworks') {
      if (modelApi === undefined) {
        if (!hasExactKeys(value, baseProfileKeys)) return null
      } else {
        if (modelApi !== 'anthropic-messages' && modelApi !== 'openai-completions') return null
        if (!hasExactKeys(value, [...baseProfileKeys, 'modelApi'])) return null
      }
    } else if (!hasExactKeys(value, baseProfileKeys)) return null
    const base = {
      id: value.id,
      label: value.label,
      defaultModel: value.defaultModel,
      apiKey: value.apiKey,
      credentialStatus: value.credentialStatus,
    }
    if (value.provider === 'fireworks') {
      const fireworksModelApi =
        modelApi === 'anthropic-messages' || modelApi === 'openai-completions' ? modelApi : undefined
      return { ...base, provider: 'fireworks', ...(fireworksModelApi && { modelApi: fireworksModelApi }) }
    }
    return { ...base, provider: value.provider }
  }

  if (value.provider !== 'openai-compat' || !isNonblankString(value.baseUrl)) return null
  if (!hasExactKeys(value, [...baseProfileKeys, 'baseUrl'])) return null
  return {
    id: value.id,
    label: value.label,
    provider: 'openai-compat',
    baseUrl: value.baseUrl,
    defaultModel: value.defaultModel,
    apiKey: value.apiKey,
    credentialStatus: value.credentialStatus,
  }
}

/** Adds exact Fireworks protocol metadata when known, or requires repair when it cannot be inferred. */
const migrateFireworksProfile = (profile: ByokProfile): ByokProfile => {
  if (profile.provider !== 'fireworks' || profile.modelApi !== undefined) return profile
  const api = piBuiltinModels().getModel('fireworks', profile.defaultModel)?.api
  if (api === 'anthropic-messages') return { ...profile, modelApi: 'anthropic-messages' }
  if (api === 'openai-completions') return { ...profile, modelApi: 'openai-completions' }
  return { ...profile, credentialStatus: 'authentication-required' }
}

/** Reconstructs the strict v3 config schema from untrusted JSON. */
const parseConfig = (value: unknown): CliConfigV3 | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'activeProviderId', 'thunderbolt', 'providers'])) {
    return null
  }
  if (value.version !== 3 || !isRecord(value.thunderbolt)) return null
  if (
    !hasExactKeys(value.thunderbolt, ['defaultModelId']) ||
    typeof value.thunderbolt.defaultModelId !== 'string' ||
    !uuidPattern.test(value.thunderbolt.defaultModelId)
  ) {
    return null
  }
  if (value.activeProviderId !== null && !isNonblankString(value.activeProviderId)) return null
  if (!Array.isArray(value.providers)) return null

  const providers: ByokProfile[] = []
  for (const candidate of value.providers) {
    const profile = parseByokProfile(candidate)
    if (profile === null) return null
    providers.push(profile)
  }

  const providerIds = new Set(providers.map((profile) => profile.id))
  if (providerIds.size !== providers.length) return null
  if (
    value.activeProviderId !== null &&
    value.activeProviderId !== 'thunderbolt' &&
    !providerIds.has(value.activeProviderId)
  ) {
    return null
  }

  return {
    version: 3,
    activeProviderId: value.activeProviderId,
    thunderbolt: { defaultModelId: value.thunderbolt.defaultModelId },
    providers,
  }
}

/** Reconstructs the historical single-provider config schema. */
const parseLegacyConfig = (value: unknown): LegacyCliConfig | null => {
  if (!isRecord(value) || !isNonblankString(value.provider) || !isNonblankString(value.model)) return null
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') return null
  if (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') return null

  if (value.provider === 'openai-compat') {
    if (
      !isNonblankString(value.baseUrl) ||
      !hasExactKeys(
        value,
        ['provider', 'model', 'apiKey', 'baseUrl'].filter((key) => key in value),
      )
    ) {
      return null
    }
    return { provider: 'openai-compat', model: value.model, apiKey: value.apiKey, baseUrl: value.baseUrl }
  }

  if (!isBuiltinProvider(value.provider) || value.baseUrl !== undefined) return null
  const allowedKeys = value.apiKey === undefined ? ['provider', 'model'] : ['provider', 'model', 'apiKey']
  if (!hasExactKeys(value, allowedKeys)) return null
  return { provider: value.provider, model: value.model, apiKey: value.apiKey }
}

/** Converts an unvalidated historical profile into active v3 BYOK state. */
const migrateLegacyConfig = (legacy: LegacyCliConfig): CliConfigV3 => {
  const id = `byok-${randomUUID()}`
  const base = {
    id,
    label: legacy.provider,
    defaultModel: legacy.model,
    apiKey: legacy.apiKey ?? null,
    credentialStatus: 'not-authenticated' as const,
  }
  const profile: ByokProfile = migrateFireworksProfile(
    legacy.provider === 'openai-compat'
      ? { ...base, provider: 'openai-compat', baseUrl: legacy.baseUrl }
      : { ...base, provider: legacy.provider },
  )

  return {
    version: 3,
    activeProviderId: id,
    thunderbolt: { defaultModelId },
    providers: [profile],
  }
}

/** Parses JSON and differentiates invalid schemas from unsupported versions. */
const parseStoredConfig = (contents: string, path: string): ParsedConfig => {
  const parsed = parseJson(contents, createStateError('config', 'config-invalid', path))

  const current = parseConfig(parsed)
  if (current !== null) return { config: current, migrated: false }

  if (isRecord(parsed) && typeof parsed.version === 'number') {
    if (parsed.version !== 3) throw createStateError('config', 'config-version-unsupported', path)
    throw createStateError('config', 'config-invalid', path)
  }
  const legacy = parseLegacyConfig(parsed)
  if (legacy !== null) return { config: migrateLegacyConfig(legacy), migrated: true }
  throw createStateError('config', 'config-invalid', path)
}

/** Loads strict v3 state and atomically migrates historical single-profile state. */
export const loadConfig = (path: string = configPath()): Promise<CliConfigV3 | null> =>
  withSecureFileLock(path, async () => {
    const contents = await readFileOrNull(path)
    if (contents === null) {
      observedConfigContents.set(path, null)
      return null
    }

    const parsed = parseStoredConfig(contents, path)
    const canonicalContents = parsed.migrated ? `${JSON.stringify(parsed.config, null, 2)}\n` : contents
    if (parsed.migrated) await writeSecureFile(path, canonicalContents)
    observedConfigContents.set(path, canonicalContents)
    return parsed.config
  })

/** Validates and atomically persists strict v3 state. */
export const saveConfig = async (config: CliConfigV3, path: string = configPath()): Promise<void> => {
  const canonical = parseConfig(config)
  if (canonical === null) throw createStateError('config', 'config-invalid', path)
  const contents = `${JSON.stringify(canonical, null, 2)}\n`
  await withSecureFileLock(path, async () => {
    const expectedContents = observedConfigContents.get(path)
    if (expectedContents !== undefined && (await readFileOrNull(path)) !== expectedContents) {
      throw new Error('Provider configuration changed on disk. Retry the command.')
    }
    await writeSecureFile(path, contents)
    observedConfigContents.set(path, contents)
  })
}
