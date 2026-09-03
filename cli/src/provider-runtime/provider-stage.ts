/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { abortable, settleBestEffort } from '../lib/abort.ts'
import type { ByokProfile, InvocationSelection, PreparedPiBinding, ProviderRuntime } from './types.ts'

export type ProviderStageEntry = {
  readonly profile: ByokProfile
}

export type ProviderStageContext = {
  readonly stage: (profile: ByokProfile) => ProviderStageEntry
  readonly get: (providerId: string) => ProviderStageEntry | null
  readonly clear: (entry: ProviderStageEntry) => boolean
}

export type ProviderPreparationOptions = {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export const defaultProviderPreparationTimeoutMs = 10_000

/** Disposes a binding that arrived after its caller had already cancelled preparation. */
const disposeLateBinding = async (operation: Promise<PreparedPiBinding>): Promise<void> => {
  try {
    const binding = await operation
    await settleBestEffort(binding.dispose())
  } catch {}
}

/** Runs every provider preparation under one deadline and optional caller cancellation signal. */
export const prepareProviderBinding = async (
  runtime: ProviderRuntime,
  selection: InvocationSelection,
  options: ProviderPreparationOptions = {},
): Promise<PreparedPiBinding> => {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? defaultProviderPreparationTimeoutMs)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
  signal.throwIfAborted()
  const operation = runtime.prepare(selection, signal)
  const awaitPrepared = async (): Promise<PreparedPiBinding> => {
    try {
      return await abortable(operation, signal)
    } catch (error) {
      if (!signal.aborted) throw error
      void disposeLateBinding(operation)
      throw signal.reason
    }
  }
  const prepared = await awaitPrepared()
  if (!signal.aborted) return prepared
  await prepared.dispose()
  throw signal.reason
}

/** Owns candidate credentials only until prepare/commit/disposal finishes. */
export const createProviderStageContext = (): ProviderStageContext => {
  const profiles = new Map<string, ProviderStageEntry>()
  return {
    stage: (profile) => {
      if (profiles.has(profile.id)) throw new Error(`Provider "${profile.id}" already staged credentials.`)
      const entry = { profile: { ...profile } }
      profiles.set(profile.id, entry)
      return entry
    },
    get: (providerId) => profiles.get(providerId) ?? null,
    clear: (entry) => {
      if (profiles.get(entry.profile.id) !== entry) return false
      return profiles.delete(entry.profile.id)
    },
  }
}

export const defaultProviderStageContext = createProviderStageContext()
