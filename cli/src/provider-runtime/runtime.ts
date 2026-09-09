/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import type { SharedModel } from '../../../shared/defaults/models.ts'
import { toError } from '@earendil-works/pi-agent-core'
import { builtinModels as piBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { CliDeviceMetadata, ensureRegisteredSession } from '../auth/account-client.ts'
import { isSecureCloudUrl } from '../auth/config.ts'
import { isConfirmedLogoutPersistenceError } from '../auth/logout.ts'
import type { loadAuthConfig, resolveAccountCredential } from '../auth/token-store.ts'
import type { loadConfig, saveConfig } from '../config/config.ts'
import { createSerialQueue } from '../lib/abort.ts'
import type { createByokBinding } from './byok.ts'
import { bundledManagedCatalog } from './catalog.ts'
import type { createManagedDirectBinding } from './direct.ts'
import type { createTinfoilBinding } from './tinfoil.ts'
import type { ProviderStageContext, ProviderStageEntry } from './provider-stage.ts'
import { isProviderRuntimeError, providerRuntimeError } from './types.ts'
import type {
  AccountActions,
  ByokProfile,
  CliAuth,
  CliConfig,
  FireworksModelApi,
  InvocationSelection,
  ManagedCatalog,
  ManagedCatalogLoader,
  PreparedPiBinding,
  ProviderCommand,
  ProviderRuntime,
  ProviderRuntimeError,
  ProviderSnapshot,
  ProviderStatus,
  ResolvedAccountCredential,
  SessionCredential,
} from './types.ts'

export type ProviderRuntimeDependencies = {
  readonly loadConfig: typeof loadConfig
  readonly saveConfig: typeof saveConfig
  readonly resolveAccountCredential: typeof resolveAccountCredential
  readonly loadAuthConfig: typeof loadAuthConfig
  readonly accountActions: AccountActions
  readonly loadCatalog: ManagedCatalogLoader
  readonly ensureRegisteredSession: typeof ensureRegisteredSession
  readonly markSessionAuthenticationRequired: (credential?: SessionCredential) => Promise<void>
  readonly metadata: CliDeviceMetadata
  readonly createByokBinding: typeof createByokBinding
  readonly createManagedDirectBinding: typeof createManagedDirectBinding
  readonly createTinfoilBinding: typeof createTinfoilBinding
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly providerStage: ProviderStageContext
}

type RuntimeError = Error & ProviderRuntimeError
type SelectedOwner = 'thunderbolt' | { readonly profile: ByokProfile; readonly stage: ProviderStageEntry | null }
type PendingPersistence = {
  readonly revision: number
  readonly previousConfig: CliConfig
  readonly profileGenerations: ReadonlyMap<string, number>
  readonly ephemeralByokStatuses: ReadonlyMap<string, ProviderStatus>
}

/** Produces an in-memory identity for compare-and-swap guards. */
const accountCredentialIdentity = (credential: ResolvedAccountCredential): string => {
  const secret = credential.type === 'session' ? credential.bearer : credential.token
  const deviceId = credential.type === 'session' ? credential.deviceId : ''
  return createHash('sha256')
    .update([credential.type, credential.backendUrl, deviceId, secret].join('\0'))
    .digest('hex')
}

/** Derives the same session identity directly from the durable post-login record. */
const authCredentialIdentity = (auth: Extract<CliAuth, { bearer: string }>): string =>
  accountCredentialIdentity({
    type: 'session',
    backendUrl: auth.backendUrl,
    bearer: auth.bearer,
    deviceId: auth.deviceId,
    userCacheSecret: new Uint8Array(),
  })

const cloneProfile = (profile: ByokProfile): ByokProfile => ({ ...profile })

/** Copies the complete persisted config so injected persistence cannot mutate runtime state. */
const cloneConfig = (config: CliConfig): CliConfig => ({
  version: 3,
  activeProviderId: config.activeProviderId,
  thunderbolt: { defaultModelId: config.thunderbolt.defaultModelId },
  providers: config.providers.map(cloneProfile),
})

/** Resolves a managed model by stable UUID or public slug. */
const managedModel = (catalog: ManagedCatalog, selector: string): SharedModel => {
  const model =
    catalog.data.find(({ id }) => id === selector) ?? catalog.data.find(({ model }) => model === selector)
  if (model) return model
  throw providerRuntimeError('model-not-found', `Managed model "${selector}" was not found.`)
}

/** Returns the persisted Fireworks protocol only for Pi's two supported APIs. */
const knownFireworksModelApi = (modelId: string): FireworksModelApi | undefined => {
  const api = piBuiltinModels().getModel('fireworks', modelId)?.api
  if (api === 'anthropic-messages') return 'anthropic-messages'
  if (api === 'openai-completions') return 'openai-completions'
  return undefined
}

const toProviderStatus = (status: ByokProfile['credentialStatus']): ProviderStatus =>
  status.replaceAll('-', ' ') as ProviderStatus

/** Creates the actionable error for PAT use with a confidential model. */
const webLoginRequiredError = (): RuntimeError =>
  providerRuntimeError('WEB_LOGIN_REQUIRED', 'Confidential models require a Thunderbolt web login.')

/** Creates the retryable failure used when an earlier account view loses its compare-and-swap race. */
const staleAccountPreparationError = (): RuntimeError =>
  providerRuntimeError(
    'authentication-required',
    'Thunderbolt authentication changed while preparing the provider. Retry the command.',
  )

/** Creates one runtime with atomically published config and exactly one binding producer per preparation. */
export const createProviderRuntime = async (dependencies: ProviderRuntimeDependencies): Promise<ProviderRuntime> => {
  const loadedConfig = await dependencies.loadConfig()
  let currentConfig = cloneConfig(
    loadedConfig ?? {
      version: 3,
      activeProviderId: null,
      thunderbolt: { defaultModelId: bundledManagedCatalog.defaultModelId },
      providers: [],
    },
  )
  const initialAuth = await dependencies.loadAuthConfig()
  const initialCredential = await dependencies.resolveAccountCredential(dependencies.environment)
  let revision = 0
  let sessionStatus: ProviderStatus =
    initialAuth?.registration === 'registered'
      ? 'authenticated'
      : initialAuth?.registration === 'authentication-required'
        ? 'authentication required'
        : 'not authenticated'
  let effectiveManagedCredentialType: ResolvedAccountCredential['type'] | null = initialCredential?.type ?? null
  let effectiveManagedCredentialIdentity =
    initialCredential === null ? null : accountCredentialIdentity(initialCredential)
  let patStatus: ProviderStatus = 'not authenticated'
  let latestCatalog: ManagedCatalog | null = null
  let accountGeneration = 0
  const profileGenerations = new Map(currentConfig.providers.map(({ id }) => [id, 0]))
  const ephemeralByokStatuses = new Map<string, ProviderStatus>()
  const mutationQueue = createSerialQueue()
  let pendingPersistence: PendingPersistence | null = null

  const effectiveThunderboltStatus = (): ProviderStatus =>
    effectiveManagedCredentialType === 'pat' ? patStatus : sessionStatus

  const mutate = mutationQueue.run

  /** Builds a fresh plain snapshot from internal state. */
  const snapshot = (): ProviderSnapshot =>
    ({
      revision,
      activeProviderId: currentConfig.activeProviderId,
      thunderbolt: {
        status: effectiveThunderboltStatus(),
        defaultModelId: currentConfig.thunderbolt.defaultModelId,
        models: (latestCatalog?.data ?? []).map(({ id, model, name, description, isConfidential }) => ({
          id,
          label: name,
          description: description ? `${model} — ${description}` : model,
          wireModel: model,
          confidential: isConfidential === 1,
        })),
      },
      providers: currentConfig.providers.map((profile) => ({
        id: profile.id,
        label: profile.label,
        provider: profile.provider,
        status: ephemeralByokStatuses.get(profile.id) ?? toProviderStatus(profile.credentialStatus),
        defaultModel: profile.defaultModel,
        modelApi: profile.provider === 'fireworks' ? profile.modelApi : undefined,
        models:
          profile.provider === 'openai-compat'
            ? [{ id: profile.defaultModel, label: profile.defaultModel }]
            : [
                { id: profile.defaultModel, label: profile.defaultModel },
                ...piBuiltinModels()
                  .getModels(profile.provider)
                  .map(({ id, name }) => ({ id, label: name, description: id })),
              ].filter((option, index, options) => options.findIndex(({ id }) => id === option.id) === index),
      })),
    })

  /** Persists a complete candidate config before publishing the corresponding in-memory state. */
  const commitConfig = async (candidate: CliConfig, rollbackable: boolean = false): Promise<void> => {
    const rollbackState = rollbackable
      ? {
          previousConfig: cloneConfig(currentConfig),
          profileGenerations: new Map(profileGenerations),
          ephemeralByokStatuses: new Map(ephemeralByokStatuses),
        }
      : null
    const next = cloneConfig(candidate)
    try {
      await dependencies.saveConfig(next)
    } catch (error) {
      throw providerRuntimeError(
        'persistence-failed',
        toError(error).message || 'Unable to persist provider configuration.',
      )
    }
    currentConfig = next
    revision += 1
    pendingPersistence = rollbackState === null ? null : { revision, ...rollbackState }
  }

  /** Restores the exact config preceding one unfinalized persistence commit. */
  const rollbackPersistence = async (expectedRevision: number): Promise<void> => {
    const pending = pendingPersistence
    if (pending === null || pending.revision !== expectedRevision || revision !== expectedRevision) {
      throw providerRuntimeError('persistence-failed', 'Provider persistence rollback is no longer current.')
    }
    const previous = cloneConfig(pending.previousConfig)
    try {
      await dependencies.saveConfig(previous)
    } catch (error) {
      throw providerRuntimeError(
        'persistence-failed',
        toError(error).message || 'Unable to restore provider configuration.',
      )
    }
    currentConfig = previous
    profileGenerations.clear()
    for (const [providerId, generation] of pending.profileGenerations) {
      profileGenerations.set(providerId, generation)
    }
    ephemeralByokStatuses.clear()
    for (const [providerId, status] of pending.ephemeralByokStatuses) {
      ephemeralByokStatuses.set(providerId, status)
    }
    pendingPersistence = null
    revision += 1
  }

  /** Releases a rollback snapshot after the matching live activation commits. */
  const finalizePersistence = (expectedRevision: number): void => {
    if (pendingPersistence?.revision !== expectedRevision) {
      throw providerRuntimeError('persistence-failed', 'Provider persistence finalization is no longer current.')
    }
    pendingPersistence = null
  }

  /** Resolves an exact profile ID or one unique exact label/provider shorthand. */
  const resolveByokProfile = (selector: string): ByokProfile => {
    const exact = currentConfig.providers.find(({ id }) => id === selector)
    if (exact) return exact

    const shorthandMatches = currentConfig.providers.filter(
      ({ label, provider }) => label === selector || provider === selector,
    )
    if (shorthandMatches.length === 1) return shorthandMatches[0] as ByokProfile
    if (shorthandMatches.length > 1) {
      const ids = shorthandMatches.map(({ id }) => id).join(', ')
      throw providerRuntimeError(
        'provider-not-found',
        `Provider shorthand "${selector}" is ambiguous; use one of these stable profile IDs: ${ids}.`,
      )
    }
    throw providerRuntimeError('provider-not-found', `Provider "${selector}" was not found.`)
  }

  /** Resolves the selected owner without permitting shorthand in persisted commands. */
  const selectedOwner = (selection: InvocationSelection): SelectedOwner => {
    const selector = selection.providerId ?? currentConfig.activeProviderId
    if (selector === null || selector === undefined) {
      throw providerRuntimeError(
        'provider-not-found',
        'No active provider is configured. Choose a provider before starting inference.',
      )
    }
    if (selector === 'thunderbolt') return selector
    const hasSavedMatch = currentConfig.providers.some(
      ({ id, label, provider }) => id === selector || label === selector || provider === selector,
    )
    if (hasSavedMatch) {
      const profile = resolveByokProfile(selector)
      const stage = profile.id === selector ? dependencies.providerStage.get(selector) : null
      return { profile: cloneProfile(stage?.profile ?? profile), stage }
    }
    if (selector !== 'openai-compat') {
      const stage = dependencies.providerStage.get(selector)
      if (stage) return { profile: cloneProfile(stage.profile), stage }
      return { profile: resolveByokProfile(selector), stage: null }
    }
    if (!selection.baseUrl?.trim())
      throw providerRuntimeError('config-invalid', 'OpenAI-compatible ad-hoc providers require --base-url.')
    if (!selection.model?.trim())
      throw providerRuntimeError('config-invalid', 'OpenAI-compatible ad-hoc providers require --model.')
    const existingStage = dependencies.providerStage.get(selector)
    if (existingStage) return { profile: cloneProfile(existingStage.profile), stage: existingStage }
    const profile: ByokProfile = {
      id: selector,
      label: 'OpenAI-compatible',
      provider: selector,
      baseUrl: selection.baseUrl,
      defaultModel: selection.model,
      apiKey: null,
      credentialStatus: 'not-authenticated',
    }
    const stage = dependencies.providerStage.stage(profile)
    return { profile: cloneProfile(stage.profile), stage }
  }

  /** Returns an exact persisted profile or rejects the command before persistence. */
  const exactProfile = (providerId: string): ByokProfile => {
    const selected = currentConfig.providers.find(({ id }) => id === providerId)
    if (selected) return selected
    throw providerRuntimeError('provider-not-found', `Provider "${providerId}" was not found.`)
  }

  /** Persists one profile status transition without changing active selection. */
  const persistByokStatus = async (
    providerId: string,
    credentialStatus: ByokProfile['credentialStatus'],
  ): Promise<void> => {
    const selected = exactProfile(providerId)
    if (selected.credentialStatus === credentialStatus) {
      ephemeralByokStatuses.delete(providerId)
      return
    }
    const providers = currentConfig.providers.map((candidate) =>
      candidate.id === providerId ? cloneProfile({ ...candidate, credentialStatus }) : cloneProfile(candidate),
    )
    await commitConfig({ ...currentConfig, providers })
    ephemeralByokStatuses.delete(providerId)
  }

  /** Clears the stored-session credential through the injected state owner. */
  const clearStoredSession = async (credential?: SessionCredential): Promise<void> => {
    await dependencies.markSessionAuthenticationRequired(credential)
    sessionStatus = 'authentication required'
    effectiveManagedCredentialType = null
    effectiveManagedCredentialIdentity = null
    accountGeneration += 1
    revision += 1
  }

  /** Applies one externally requested provider mutation under the serialization gate. */
  const manage = (command: ProviderCommand): Promise<ProviderSnapshot> =>
    mutate(async () => {
      if (command.type === 'rollback-persistence') {
        await rollbackPersistence(command.revision)
        return snapshot()
      }

      if (command.type === 'finalize-persistence') {
        finalizePersistence(command.revision)
        return snapshot()
      }

      const requested = command.type === 'commit-persistence' ? command.command : command
      const rollbackable = command.type === 'commit-persistence'

      if (requested.type === 'login') {
        const auth = await dependencies.accountActions.login(requested.presentation, requested.signal)
        requested.signal?.throwIfAborted()
        sessionStatus = 'authenticated'
        const effectiveCredential = await dependencies.resolveAccountCredential(dependencies.environment)
        effectiveManagedCredentialType = effectiveCredential?.type ?? 'session'
        effectiveManagedCredentialIdentity =
          effectiveCredential === null ? authCredentialIdentity(auth) : accountCredentialIdentity(effectiveCredential)
        accountGeneration += 1
        revision += 1
        latestCatalog = await dependencies.loadCatalog(auth.backendUrl)
        return snapshot()
      }

      if (requested.type === 'logout') {
        const performLogout = async (): ReturnType<AccountActions['logout']> => {
          try {
            return await dependencies.accountActions.logout(requested.presentation, requested.signal)
          } catch (error) {
            const failure = toError(error)
            if (!isConfirmedLogoutPersistenceError(failure)) throw failure
            sessionStatus = failure.authenticationRequired === true ? 'authentication required' : 'not authenticated'
            if (effectiveManagedCredentialType !== 'pat') {
              effectiveManagedCredentialType = null
              effectiveManagedCredentialIdentity = null
            }
            accountGeneration += 1
            revision += 1
            throw failure
          }
        }
        const result = await performLogout()
        if (result === 'pat-managed-externally') {
          requested.signal?.throwIfAborted()
          return snapshot()
        }
        sessionStatus = result === 'authentication-required' ? 'authentication required' : 'not authenticated'
        if (effectiveManagedCredentialType !== 'pat') {
          effectiveManagedCredentialType = null
          effectiveManagedCredentialIdentity = null
        }
        accountGeneration += 1
        revision += 1
        return snapshot()
      }

      if (requested.type === 'clear-active') {
        await commitConfig({ ...currentConfig, activeProviderId: null })
        return snapshot()
      }

      if (requested.type === 'load-models') {
        if (requested.providerId !== 'thunderbolt') return snapshot()
        const credential = await dependencies.resolveAccountCredential(dependencies.environment)
        if (credential === null) {
          throw providerRuntimeError(
            'authentication-required',
            'Thunderbolt login or THUNDERBOLT_TOKEN is required to load managed models.',
          )
        }
        latestCatalog = await dependencies.loadCatalog(credential.backendUrl)
        revision += 1
        return snapshot()
      }

      if (requested.type === 'use') {
        if (requested.providerId !== 'thunderbolt') exactProfile(requested.providerId)
        const selectedManagedModel =
          requested.providerId === 'thunderbolt' && requested.model !== undefined
            ? managedModel(latestCatalog ?? bundledManagedCatalog, requested.model)
            : null
        await commitConfig(
          {
            ...currentConfig,
            activeProviderId: requested.providerId,
            thunderbolt:
              selectedManagedModel === null ? currentConfig.thunderbolt : { defaultModelId: selectedManagedModel.id },
          },
          rollbackable,
        )
        return snapshot()
      }

      if (requested.type === 'commit-staged-byok') {
        const stage = dependencies.providerStage.get(requested.providerId)
        if (stage === null) {
          throw providerRuntimeError(
            'config-invalid',
            `Provider "${requested.providerId}" has no staged credentials.`,
          )
        }
        const candidateProfile = stage.profile
        if (candidateProfile.id === 'thunderbolt' || candidateProfile.id.trim() === '') {
          throw providerRuntimeError('config-invalid', 'BYOK profiles require a unique stable ID.')
        }
        const existingIndex = currentConfig.providers.findIndex(({ id }) => id === candidateProfile.id)
        const providers = currentConfig.providers.map(cloneProfile)
        if (existingIndex === -1) providers.push(cloneProfile(candidateProfile))
        else providers[existingIndex] = cloneProfile(candidateProfile)
        try {
          await commitConfig(
            {
              ...currentConfig,
              activeProviderId: requested.activate ? candidateProfile.id : currentConfig.activeProviderId,
              providers,
            },
            rollbackable,
          )
        } finally {
          dependencies.providerStage.clear(stage)
        }
        ephemeralByokStatuses.delete(candidateProfile.id)
        profileGenerations.set(candidateProfile.id, (profileGenerations.get(candidateProfile.id) ?? 0) + 1)
        return snapshot()
      }

      if (requested.type === 'remove-byok') {
        exactProfile(requested.providerId)
        const providers = currentConfig.providers.filter(({ id }) => id !== requested.providerId).map(cloneProfile)
        await commitConfig({
          ...currentConfig,
          activeProviderId:
            currentConfig.activeProviderId === requested.providerId ? null : currentConfig.activeProviderId,
          providers,
        })
        ephemeralByokStatuses.delete(requested.providerId)
        profileGenerations.delete(requested.providerId)
        return snapshot()
      }

      if (requested.providerId === 'thunderbolt') {
        const credential = await dependencies.resolveAccountCredential(dependencies.environment)
        if (credential === null) {
          throw providerRuntimeError(
            'authentication-required',
            'Thunderbolt login is required before selecting a managed model.',
          )
        }
        const catalog = latestCatalog ?? (await dependencies.loadCatalog(credential.backendUrl))
        latestCatalog = catalog
        const model = managedModel(catalog, requested.model)
        await commitConfig(
          {
            ...currentConfig,
            thunderbolt: { defaultModelId: model.id },
          },
          rollbackable,
        )
        return snapshot()
      }

      const selected = exactProfile(requested.providerId)
      const selectedFireworksApi =
        selected.provider === 'fireworks' ? knownFireworksModelApi(requested.model) : undefined
      if (selected.provider === 'fireworks' && selectedFireworksApi === undefined && selected.modelApi === undefined) {
        throw providerRuntimeError(
          'authentication-required',
          `Fireworks model "${requested.model}" requires an explicit API format.`,
        )
      }
      const providers = currentConfig.providers.map((candidate) =>
        candidate.id === selected.id
          ? cloneProfile(
              candidate.provider === 'fireworks'
                ? {
                    ...candidate,
                    defaultModel: requested.model,
                    modelApi: selectedFireworksApi ?? candidate.modelApi,
                  }
                : { ...candidate, defaultModel: requested.model },
            )
          : cloneProfile(candidate),
      )
      await commitConfig({ ...currentConfig, providers }, rollbackable)
      return snapshot()
    })

  /** Prepares one BYOK profile without treating local binding construction as authentication proof. */
  const prepareByok = async (
    selected: ByokProfile,
    selection: InvocationSelection,
    stage: ProviderStageEntry | null,
  ): Promise<PreparedPiBinding> => {
    const currentGeneration = profileGenerations.get(selected.id) ?? 0
    const preparedGeneration = currentGeneration + (stage ? 1 : 0)
    let persistsCredentialStatus = false
    const observeResponse = async (response: Response): Promise<void> => {
      const status = response.ok
        ? 'authenticated'
        : response.status === 401 || response.status === 403
          ? 'authentication required'
          : null
      if (status === null || profileGenerations.get(selected.id) !== preparedGeneration) return
      if (persistsCredentialStatus) {
        await mutate(async () => {
          if (profileGenerations.get(selected.id) !== preparedGeneration) return
          await persistByokStatus(selected.id, status === 'authenticated' ? 'authenticated' : 'authentication-required')
        })
        return
      }
      if (ephemeralByokStatuses.get(selected.id) === status) return
      ephemeralByokStatuses.set(selected.id, status)
      revision += 1
    }
    const prepared = await (async (): Promise<PreparedPiBinding> => {
      try {
        if (selected.provider === 'openai-compat' && !isSecureCloudUrl(selection.baseUrl ?? selected.baseUrl)) {
          throw providerRuntimeError(
            'config-invalid',
            'OpenAI-compatible endpoints must use https (or loopback http).',
          )
        }
        return await dependencies.createByokBinding(
          cloneProfile(selected),
          { ...selection, providerId: selected.id },
          dependencies.environment,
          observeResponse,
        )
      } catch (error) {
        if (stage) dependencies.providerStage.clear(stage)
        throw error
      }
    })()
    persistsCredentialStatus = prepared.persistsCredentialStatus
    if (!stage) return prepared
    return {
      ...prepared,
      dispose: async () => {
        dependencies.providerStage.clear(stage)
        await prepared.dispose()
      },
    }
  }

  /** Prepares one managed catalog model after account registration and transport selection. */
  const prepareManaged = async (
    selection: InvocationSelection,
    signal?: AbortSignal,
  ): Promise<PreparedPiBinding> => {
    const preparedGeneration = accountGeneration
    const preparedIdentity = effectiveManagedCredentialIdentity
    const accountStateIsCurrent = (): boolean =>
      accountGeneration === preparedGeneration && effectiveManagedCredentialIdentity === preparedIdentity
    const assertAccountStateIsCurrent = (): void => {
      if (accountStateIsCurrent()) return
      throw staleAccountPreparationError()
    }

    if (selection.baseUrl !== undefined || selection.apiKey !== undefined) {
      throw providerRuntimeError(
        'config-invalid',
        'Managed Thunderbolt credentials and endpoints cannot be overridden by BYOK flags.',
      )
    }
    const credential = await dependencies.resolveAccountCredential(dependencies.environment)
    assertAccountStateIsCurrent()
    if (credential === null) {
      throw providerRuntimeError(
        'authentication-required',
        'Thunderbolt login or THUNDERBOLT_TOKEN is required for managed inference.',
      )
    }
    if (accountCredentialIdentity(credential) !== preparedIdentity) {
      throw staleAccountPreparationError()
    }
    const catalog = await dependencies.loadCatalog(credential.backendUrl)
    assertAccountStateIsCurrent()
    const model = managedModel(catalog, selection.model ?? currentConfig.thunderbolt.defaultModelId)
    if (credential.type === 'pat' && model.isConfidential === 1) throw webLoginRequiredError()

    const registeredCredential = await (async (): Promise<ResolvedAccountCredential> => {
      if (credential.type === 'pat') return credential
      try {
        return await dependencies.ensureRegisteredSession(
          credential,
          dependencies.metadata,
          undefined,
          signal,
        )
      } catch (error) {
        const failure = toError(error)
        if (
          isProviderRuntimeError(failure) &&
          (failure.code === 'authentication-required' ||
            failure.code === 'authentication-rejected' ||
            failure.code === 'device-disconnected')
        ) {
          if (accountStateIsCurrent()) {
            sessionStatus = 'authentication required'
            effectiveManagedCredentialType = null
            effectiveManagedCredentialIdentity = null
            revision += 1
          }
        }
        throw failure
      }
    })()
    assertAccountStateIsCurrent()
    const registeredIdentity = accountCredentialIdentity(registeredCredential)
    let sessionRejected = false
    const onStoredSessionRejected = async (): Promise<void> => {
      if (registeredCredential.type !== 'session' || sessionRejected) return
      await mutate(async () => {
        if (
          sessionRejected ||
          accountGeneration !== preparedGeneration ||
          effectiveManagedCredentialIdentity !== registeredIdentity
        ) {
          return
        }
        await clearStoredSession(registeredCredential)
        sessionRejected = true
      })
    }
    const createBinding = async (): Promise<PreparedPiBinding> => {
      if (model.isConfidential === 1) {
        return dependencies.createTinfoilBinding({
          credential: registeredCredential as SessionCredential,
          model,
          onStoredSessionRejected,
        })
      }
      return dependencies.createManagedDirectBinding({
        credential: registeredCredential,
        model,
        observeResponse: async (response) => {
          if (accountGeneration !== preparedGeneration || effectiveManagedCredentialIdentity !== registeredIdentity) {
            return
          }
          if (response.ok) {
            if (registeredCredential.type === 'pat' && patStatus !== 'authenticated') {
              patStatus = 'authenticated'
              revision += 1
            }
            return
          }
          if (response.status !== 401 && response.status !== 403) return
          if (registeredCredential.type === 'session') {
            await onStoredSessionRejected()
            return
          }
          if (patStatus !== 'authentication required') {
            patStatus = 'authentication required'
            revision += 1
          }
        },
      })
    }
    const prepared = await createBinding()

    if (!accountStateIsCurrent()) {
      await prepared.dispose()
      assertAccountStateIsCurrent()
    }
    latestCatalog = catalog
    effectiveManagedCredentialType = registeredCredential.type
    effectiveManagedCredentialIdentity = registeredIdentity
    if (registeredCredential.type === 'session') sessionStatus = 'authenticated'
    return prepared
  }

  const prepare = async (selection: InvocationSelection, signal?: AbortSignal): Promise<PreparedPiBinding> => {
    const owner = selectedOwner(selection)
    if (owner === 'thunderbolt') return prepareManaged(selection, signal)
    return prepareByok(owner.profile, selection, owner.stage)
  }

  return { snapshot, manage, prepare }
}
