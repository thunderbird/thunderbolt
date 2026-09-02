/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InferenceProvider } from './client'

export type ManagedDirectRuntime = {
  provider: Extract<InferenceProvider, 'anthropic' | 'tinfoil'>
  internalName: string
  supportsStreamUsage: boolean
  /** Whether to omit `temperature` from the upstream payload. */
  omitTemperature?: boolean
}

/** Private upstream routing for public direct managed-model slugs. */
export const managedDirectRuntimes = {
  'opus-5': {
    provider: 'anthropic',
    internalName: 'claude-opus-5',
    omitTemperature: true,
    supportsStreamUsage: true,
  },
  'deepseek-v4-flash': {
    provider: 'tinfoil',
    internalName: 'deepseek-v4-flash',
    supportsStreamUsage: true,
  },
} as const satisfies Readonly<Record<string, ManagedDirectRuntime>>

/** Resolve a public direct slug without consulting inherited object properties. */
export const resolveManagedDirectRuntime = (model: string): ManagedDirectRuntime | undefined =>
  Object.hasOwn(managedDirectRuntimes, model)
    ? managedDirectRuntimes[model as keyof typeof managedDirectRuntimes]
    : undefined
