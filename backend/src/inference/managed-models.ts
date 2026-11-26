/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModelOpus55, defaultModels, type SharedModel } from '@shared/defaults/models'
import type { ManagedDirectProvider } from './client'
import type { ManagedInferenceIdentity } from './usage-ledger'

export type ManagedDirectRuntime = {
  provider: 'anthropic'
  internalName: string
  supportsStreamUsage: boolean
  /** Whether to omit `temperature` from the upstream payload. */
  omitTemperature?: boolean
  /** The model's output limit, which bounds a request's hold when the request sets no lower one. */
  maxOutputTokens: number
  /** The model's context window. It bounds the prompt of a request whose text cannot size its content. */
  contextWindow: number
}

/** A catalog model's context window, which a direct runtime needs to size the holds of unsized content. */
const catalogContextWindow = ({ model, contextWindow }: SharedModel): number => {
  if (contextWindow === null) {
    throw new Error(`The model catalog sets no context window for ${model}`)
  }
  return contextWindow
}

/** Private upstream routing for public direct managed-model slugs. */
export const managedDirectRuntimes = {
  'opus-5-5': {
    provider: 'anthropic',
    internalName: 'claude-opus-5-5',
    omitTemperature: true,
    supportsStreamUsage: true,
    // https://platform.claude.com/docs/en/about-claude/models/overview
    maxOutputTokens: 128_000,
    contextWindow: catalogContextWindow(defaultModelOpus55),
  },
} as const satisfies Readonly<Record<string, ManagedDirectRuntime>>

/** Resolve a public direct slug without consulting inherited object properties. */
export const resolveManagedDirectRuntime = (model: string): ManagedDirectRuntime | undefined =>
  Object.hasOwn(managedDirectRuntimes, model)
    ? managedDirectRuntimes[model as keyof typeof managedDirectRuntimes]
    : undefined

const legacyConfidentialModels = ['glm-5-2', 'deepseek-v4-flash', 'glm-5-3-flash']
const confidentialCatalog = defaultModels.filter(
  ({ provider, isConfidential }) => provider === 'tinfoil' && isConfidential === 1,
)
const confidentialManagedModels = new Map<string, ManagedInferenceIdentity>(
  [...confidentialCatalog.map(({ model }) => model), ...legacyConfidentialModels].map((model) => [
    model,
    { provider: 'tinfoil', model },
  ]),
)

/** Resolve confidential managed catalog and legacy identities, without prototype-property lookups. */
export const resolveConfidentialManagedModel = (model: string): ManagedInferenceIdentity | undefined =>
  confidentialManagedModels.get(model)

const largestConfidentialContextWindow = Math.max(...confidentialCatalog.map(({ contextWindow }) => contextWindow ?? 0))

/**
 * The tokens one confidential request can use, prompt and output together. This is the model's catalog context
 * window, which the enclave's server enforces. A legacy id the catalog no longer lists gets the largest window.
 */
export const confidentialContextWindow = (model: string): number =>
  confidentialCatalog.find((entry) => entry.model === model)?.contextWindow ?? largestConfidentialContextWindow

export type ManagedAgentIdentity = ManagedInferenceIdentity & { provider: ManagedDirectProvider }

/**
 * The models the hosted agent may run as `AGENT_MODEL`, keyed by the id the provider's API takes: a Fireworks
 * serverless id (`accounts/fireworks/models/<name>`), or the upstream id of a `managedDirectRuntimes` model.
 * Each needs a price row too, which admission checks per request.
 */
export const managedAgentModels = new Map<string, ManagedAgentIdentity>(
  [
    { provider: 'fireworks', model: 'accounts/fireworks/models/glm-5p3' } as const,
    { provider: 'fireworks', model: 'accounts/fireworks/models/minimax-m3' } as const,
    ...Object.values(managedDirectRuntimes).map(({ provider, internalName }) => ({ provider, model: internalName })),
  ].map((identity) => [identity.model, identity]),
)
