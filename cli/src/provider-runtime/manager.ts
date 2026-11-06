/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isConfirmedLogoutPersistenceError, type ConfirmedLogoutPersistenceError } from '../auth/logout.ts'
import { listModels } from '../config/model-listing.ts'
import { collectByokProfile, collectByokRepair } from '../config/wizard.ts'
import {
  defaultProviderStageContext,
  prepareProviderBinding,
  type ProviderStageContext,
} from './provider-stage.ts'
import type {
  CommandOutcome,
  ProviderManagerIO,
  ProviderManagerMode,
  ProviderRuntime,
  ProviderSnapshot,
} from './types.ts'

export type ProviderManagerDependencies = {
  readonly listByokModels: typeof listModels
  readonly providerStage: ProviderStageContext
}

type LiveProviderId = () => string | null

const handled = { kind: 'handled' } as const satisfies CommandOutcome

/** Resolves the harness owner when one exists, otherwise the persisted default. */
const activeProviderId = (snapshot: ProviderSnapshot, liveProviderId?: LiveProviderId): string | null => {
  return liveProviderId === undefined ? snapshot.activeProviderId : liveProviderId()
}

/** Activates one provider through a deferred HarnessRuntime transaction. */
const switchProvider = (providerId: string): CommandOutcome => ({
  kind: 'switch',
  selection: { providerId },
  persist: { type: 'use', providerId },
  forceReplace: false,
})

/** Performs web login, activating an empty configuration while preserving an active BYOK provider. */
const login = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  forceActivation: boolean,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const previousProviderId = activeProviderId(runtime.snapshot(), liveProviderId)
  const state = await runtime.manage({
    type: 'login',
    presentation: io,
    signal,
  })
  const options = state.thunderbolt.models ?? []
  if (options.length === 0) throw new Error('Managed model catalog is unavailable after login.')
  const selectedModel = (await io.choose('Models', options)) ?? state.thunderbolt.defaultModelId
  if (!forceActivation && previousProviderId !== null && previousProviderId !== 'thunderbolt') {
    await runtime.manage({ type: 'select-model', providerId: 'thunderbolt', model: selectedModel })
    return handled
  }
  const activate = forceActivation || previousProviderId === null
  return {
    kind: 'switch',
    selection: { providerId: 'thunderbolt', model: selectedModel },
    persist: activate
      ? { type: 'use', providerId: 'thunderbolt', model: selectedModel }
      : { type: 'select-model', providerId: 'thunderbolt', model: selectedModel },
    forceReplace: true,
  }
}

/** Logs out the stored session while leaving a currently active BYOK binding untouched. */
const logout = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const before = runtime.snapshot()
  const wasThunderboltActive = activeProviderId(before, liveProviderId) === 'thunderbolt'
  const logoutFailure = async (): Promise<ConfirmedLogoutPersistenceError | undefined> => {
    try {
      await runtime.manage({ type: 'logout', presentation: io, signal })
      return undefined
    } catch (error) {
      if (!(error instanceof Error) || !isConfirmedLogoutPersistenceError(error)) throw error
      return error
    }
  }
  const failure = await logoutFailure()
  if (failure !== undefined && !wasThunderboltActive) throw failure
  if (!wasThunderboltActive) return handled
  const outcome = {
    kind: 'deactivate',
    persist: before.activeProviderId === 'thunderbolt' ? { type: 'clear-active' } : null,
  } as const satisfies CommandOutcome
  return failure === undefined ? outcome : { ...outcome, failure }
}

/** Adds an authentication-required draft before deferring credential persistence until activation. */
const addByok = async (
  io: ProviderManagerIO,
  dependencies: ProviderManagerDependencies,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const collected = await collectByokProfile(io, { list: dependencies.listByokModels }, signal)
  if (collected === null) return handled
  dependencies.providerStage.stage(collected.profile)
  return {
    kind: 'switch',
    selection: { providerId: collected.profile.id },
    persist: { type: 'commit-staged-byok', providerId: collected.profile.id, activate: true },
    forceReplace: false,
  }
}

/** Repairs one profile, validating inactive replacements before immediate persistence. */
const repairByok = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  snapshot: ProviderSnapshot,
  providerId: string,
  dependencies: ProviderManagerDependencies,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const selected = snapshot.providers.find(({ id }) => id === providerId)
  if (selected === undefined) return handled
  const repaired = await collectByokRepair(io, selected, { list: dependencies.listByokModels }, signal)
  if (repaired === null) return handled
  dependencies.providerStage.stage(repaired.profile)
  const selection = { providerId }
  const persist = { type: 'commit-staged-byok', providerId, activate: false } as const
  if (activeProviderId(snapshot, liveProviderId) === providerId) {
    return { kind: 'switch', selection, persist, forceReplace: true }
  }

  const prepared = await prepareProviderBinding(runtime, selection, { signal })
  try {
    await runtime.manage(persist)
  } finally {
    await prepared.dispose()
  }
  return handled
}

/** Removes a profile immediately only when no live harness binding owns it. */
const removeByok = async (
  runtime: ProviderRuntime,
  snapshot: ProviderSnapshot,
  providerId: string,
  liveProviderId?: LiveProviderId,
): Promise<CommandOutcome> => {
  const persist = { type: 'remove-byok', providerId } as const
  if (activeProviderId(snapshot, liveProviderId) === providerId) return { kind: 'deactivate', persist }
  await runtime.manage(persist)
  return handled
}

/** Handles the action menu for structural Thunderbolt. */
const manageThunderbolt = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const action = await io.choose('Thunderbolt', [
    { id: 'use', label: 'Use Thunderbolt' },
    { id: 'login', label: 'Log in' },
    { id: 'logout', label: 'Log out' },
  ])
  if (action === 'use') return switchProvider('thunderbolt')
  if (action === 'login') return login(io, runtime, false, liveProviderId, signal)
  if (action === 'logout') return logout(io, runtime, liveProviderId, signal)
  return handled
}

/** Handles use, repair, and removal for one BYOK profile row. */
const manageByok = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  snapshot: ProviderSnapshot,
  providerId: string,
  dependencies: ProviderManagerDependencies,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const selected = snapshot.providers.find(({ id }) => id === providerId)
  if (selected === undefined) return handled
  const action = await io.choose(selected.label, [
    { id: 'use', label: 'Use provider' },
    { id: 'repair', label: 'Repair credentials' },
    { id: 'remove', label: 'Remove provider' },
  ])
  if (action === 'use') return switchProvider(providerId)
  if (action === 'repair') return repairByok(io, runtime, snapshot, providerId, dependencies, liveProviderId, signal)
  if (action === 'remove') return removeByok(runtime, snapshot, providerId, liveProviderId)
  return handled
}

/** Displays structural Thunderbolt first, followed only by user-created BYOK profiles. */
const providers = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  dependencies: ProviderManagerDependencies,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const state = runtime.snapshot()
  const selected = await io.choose('Providers', [
    { id: 'thunderbolt', label: 'Thunderbolt', description: state.thunderbolt.status },
    ...state.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: `${provider.provider} — ${provider.status}`,
    })),
    { id: 'add-byok', label: 'Add provider API key' },
  ])
  if (selected === null) return handled
  if (selected === 'add-byok') return addByok(io, dependencies, signal)
  if (selected === 'thunderbolt') return manageThunderbolt(io, runtime, liveProviderId, signal)
  return manageByok(io, runtime, state, selected, dependencies, liveProviderId, signal)
}

/** Returns a deferred active-model change without mutating persisted selection early. */
const models = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  liveProviderId?: LiveProviderId,
): Promise<CommandOutcome> => {
  const initial = runtime.snapshot()
  const initialProviderId = activeProviderId(initial, liveProviderId)
  const state =
    initialProviderId === 'thunderbolt'
      ? await runtime.manage({ type: 'load-models', providerId: 'thunderbolt' })
      : initial
  const providerId = activeProviderId(state, liveProviderId)
  if (providerId === null) {
    io.write('Choose a provider before selecting a model.\n')
    return handled
  }
  const options =
    providerId === 'thunderbolt'
      ? (state.thunderbolt.models ?? [])
      : (state.providers.find(({ id }) => id === providerId)?.models ?? [])
  if (options.length === 0) throw new Error(`Model catalog is unavailable for provider "${providerId}".`)
  const selectedModel = await io.choose('Models', options)
  if (selectedModel === null) return handled
  return {
    kind: 'switch',
    selection: { providerId, model: selectedModel },
    persist: { type: 'select-model', providerId, model: selectedModel },
    forceReplace: false,
  }
}

/** Runs first-run connection choice without auto-running when a migrated profile remains active. */
const firstRun = async (
  io: ProviderManagerIO,
  runtime: ProviderRuntime,
  dependencies: ProviderManagerDependencies,
  liveProviderId: LiveProviderId | undefined,
  signal?: AbortSignal,
): Promise<CommandOutcome> => {
  const selected = await io.choose('Choose how to connect', [
    { id: 'thunderbolt-account', label: 'Thunderbolt account', description: 'recommended' },
    { id: 'provider-api-key', label: 'Provider API key' },
  ])
  if (selected === 'thunderbolt-account') return login(io, runtime, true, liveProviderId, signal)
  if (selected === 'provider-api-key') return addByok(io, dependencies, signal)
  return handled
}

/** Creates the provider manager with its required model-list dependency. */
export const createProviderManager =
  (dependencies: ProviderManagerDependencies) =>
  async (
    io: ProviderManagerIO,
    runtime: ProviderRuntime,
    mode: ProviderManagerMode,
    signal?: AbortSignal,
    liveProviderId?: LiveProviderId,
  ): Promise<CommandOutcome> => {
    if (mode === 'providers') return providers(io, runtime, dependencies, liveProviderId, signal)
    if (mode === 'models') return models(io, runtime, liveProviderId)
    if (mode === 'first-run') return firstRun(io, runtime, dependencies, liveProviderId, signal)
    if (mode === 'login') return login(io, runtime, false, liveProviderId, signal)
    return logout(io, runtime, liveProviderId, signal)
  }

export const runProviderManager = createProviderManager({
  listByokModels: listModels,
  providerStage: defaultProviderStageContext,
})
