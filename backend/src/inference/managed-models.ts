/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModels } from '@shared/defaults/models'
import type { ManagedInferenceIdentity } from './usage-ledger'

export type ManagedDirectRuntime = {
  provider: 'anthropic'
  internalName: string
  supportsStreamUsage: boolean
  /** Whether to omit `temperature` from the upstream payload. */
  omitTemperature?: boolean
}

/** Private upstream routing for public direct managed-model slugs. */
export const managedDirectRuntimes = {
  'opus-5-5': {
    provider: 'anthropic',
    internalName: 'claude-opus-5-5',
    omitTemperature: true,
    supportsStreamUsage: true,
  },
} as const satisfies Readonly<Record<string, ManagedDirectRuntime>>

/**
 * Direct slugs the catalog has moved past, kept resolvable for clients that have
 * not reloaded since the rollout. `upgradeModelDefaults` rewrites the row on next
 * boot, so an alias only has to cover tabs open across a deploy — it points at the
 * slug that replaced it rather than keeping a retired upstream (and its price)
 * alive. Mirrors `legacyConfidentialModels` below.
 */
const legacyDirectSlugs: Readonly<Record<string, keyof typeof managedDirectRuntimes>> = {
  'opus-5': 'opus-5-5',
}

/** Resolve a public direct slug without consulting inherited object properties. */
export const resolveManagedDirectRuntime = (model: string): ManagedDirectRuntime | undefined => {
  const slug = Object.hasOwn(legacyDirectSlugs, model) ? legacyDirectSlugs[model] : model
  return Object.hasOwn(managedDirectRuntimes, slug)
    ? managedDirectRuntimes[slug as keyof typeof managedDirectRuntimes]
    : undefined
}

const legacyConfidentialModels = ['glm-5-2', 'deepseek-v4-flash']
const confidentialManagedModels = new Map<string, ManagedInferenceIdentity>(
  [
    ...defaultModels
      .filter(({ provider, isConfidential }) => provider === 'tinfoil' && isConfidential === 1)
      .map(({ model }) => model),
    ...legacyConfidentialModels,
  ].map((model) => [model, { provider: 'tinfoil', model }]),
)

/** Resolve confidential managed catalog and legacy identities, without prototype-property lookups. */
export const resolveConfidentialManagedModel = (model: string): ManagedInferenceIdentity | undefined =>
  confidentialManagedModels.get(model)
