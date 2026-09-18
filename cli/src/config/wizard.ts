/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** First-run provider setup and its injectable terminal I/O seam. */

import { randomUUID } from 'node:crypto'
import { builtinModels as piBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { defaultModels } from '../agent/defaults.ts'
import { isBuiltinProvider } from '../agent/types.ts'
import type { BuiltinProvider } from '../agent/types.ts'
import type { ByokProfile, ProviderManagerIO, ProviderSnapshot } from '../provider-runtime/types.ts'
import { listModels } from './model-listing.ts'
import type { ModelListingResult } from './model-listing.ts'

type BuiltinChoice = {
  readonly id: `builtin:${BuiltinProvider}`
  readonly kind: 'builtin'
  readonly label: string
  readonly provider: BuiltinProvider
}

type CompatChoice = {
  readonly id: 'compat:ollama' | 'compat:lm-studio' | 'compat:custom'
  readonly kind: 'compat'
  readonly label: string
  readonly baseUrl?: string
  readonly isLocal: boolean
}

type ProviderChoice = BuiltinChoice | CompatChoice

export type CollectedByokProfile = {
  readonly profile: ByokProfile
  readonly apiKey: string
}

export type CollectByokProfileDependencies = {
  readonly list?: typeof listModels
}

type ResolvedProvider =
  | { readonly provider: 'openai-compat'; readonly baseUrl: string }
  | { readonly provider: BuiltinProvider }

/** Menu labels in curated display order. Keyed by `BuiltinProvider` so adding
 *  a provider to `builtinProviders` is a compile error here until it gets a
 *  label — the menu row then falls out automatically. */
const builtinProviderLabels: Readonly<Record<BuiltinProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
  xai: 'xAI (Grok)',
  deepseek: 'DeepSeek',
  zai: 'Z.AI',
  moonshotai: 'Moonshot (Kimi)',
  mistral: 'Mistral',
  groq: 'Groq',
  cerebras: 'Cerebras',
  openrouter: 'OpenRouter',
  together: 'Together',
  fireworks: 'Fireworks',
  minimax: 'MiniMax',
}

const providerChoices: readonly ProviderChoice[] = [
  ...(Object.keys(builtinProviderLabels) as readonly BuiltinProvider[]).map(
    (provider): BuiltinChoice => ({
      id: `builtin:${provider}`,
      kind: 'builtin',
      label: builtinProviderLabels[provider],
      provider,
    }),
  ),
  {
    id: 'compat:ollama',
    kind: 'compat',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    isLocal: true,
  },
  {
    id: 'compat:lm-studio',
    kind: 'compat',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    isLocal: true,
  },
  { id: 'compat:custom', kind: 'compat', label: 'Custom OpenAI-compatible endpoint', isLocal: false },
]

/** Builds unique default-first model suggestions from live then Pi catalog ids. */
const modelChoices = (provider: BuiltinProvider, ids: readonly string[]): readonly string[] => [
  ...new Set([defaultModels[provider], ...ids, ...piBuiltinModels().getModels(provider).map(({ id }) => id)]),
]

/** Reads one nonblank value, allowing the caller to supply an empty-input fallback. */
const readNonblank = async (
  read: (prompt: string) => Promise<string | null>,
  prompt: string,
  onBlank: () => string | undefined,
): Promise<string | null> => {
  while (true) {
    const answer = await read(prompt)
    if (answer === null) return null
    if (answer.trim() !== '') return answer.trim()
    const fallback = onBlank()
    if (fallback !== undefined) return fallback
  }
}

const readManagerRequiredText = (io: ProviderManagerIO, prompt: string): Promise<string | null> =>
  readNonblank(io.readText, prompt, () => {
    io.write('Value required.\n')
    return undefined
  })

const readManagerSecret = (io: ProviderManagerIO, prompt: string, isLocal: boolean): Promise<string | null> =>
  readNonblank(io.readSecret, prompt, () => {
    if (isLocal) return 'local'
    io.write('API key required.\n')
    return undefined
  })

/** Resolves a manager provider choice to its configured base URL, if any. */
const resolveManagerChoice = async (
  io: ProviderManagerIO,
  choice: ProviderChoice,
): Promise<ResolvedProvider | null> => {
  if (choice.kind === 'builtin') return { provider: choice.provider }
  if (choice.baseUrl !== undefined) return { provider: 'openai-compat', baseUrl: choice.baseUrl }
  const baseUrl = await readManagerRequiredText(io, 'Base URL: ')
  return baseUrl === null ? null : { provider: 'openai-compat', baseUrl }
}

/** Reads one model from live/catalog choices, falling back to a required free-form ID. */
const chooseManagerModel = async (
  io: ProviderManagerIO,
  choice: ProviderChoice,
  listing: ModelListingResult,
): Promise<string | null> => {
  const choices = choice.kind === 'builtin' ? modelChoices(choice.provider, listing.ids) : [...new Set(listing.ids)]
  if (choices.length === 0) return readManagerRequiredText(io, 'Model id: ')
  const selected = await io.choose(listing.source === 'catalog' ? 'Models (offline list)' : 'Models', [
    ...choices.map((id, index) => ({
      id,
      label: id,
      description: choice.kind === 'builtin' && index === 0 ? 'default' : undefined,
    })),
    ...(choice.kind === 'builtin' && choice.provider === 'fireworks'
      ? [{ id: 'fireworks:custom', label: 'Other Fireworks model' }]
      : []),
  ])
  if (selected === 'fireworks:custom') return readManagerRequiredText(io, 'Fireworks model id: ')
  return selected
}

/** Resolves a known Fireworks protocol or asks for one when the model is absent from Pi's catalog. */
const fireworksModelApi = async (
  io: ProviderManagerIO,
  modelId: string,
): Promise<'anthropic-messages' | 'openai-completions' | null> => {
  const known = piBuiltinModels().getModel('fireworks', modelId)
  if (known?.api === 'anthropic-messages') return 'anthropic-messages'
  if (known?.api === 'openai-completions') return 'openai-completions'
  const selected = await io.choose('Fireworks API format', [
    { id: 'anthropic-messages', label: 'Anthropic Messages', description: '/inference' },
    { id: 'openai-completions', label: 'OpenAI Completions', description: '/inference/v1' },
  ])
  if (selected === 'anthropic-messages') return 'anthropic-messages'
  if (selected === 'openai-completions') return 'openai-completions'
  return null
}

/** Lists models with one credential correction after an explicit 401/403. */
const listManagerModels = async (
  io: ProviderManagerIO,
  options: {
    readonly choice: ProviderChoice
    readonly resolved: ResolvedProvider
    readonly initialApiKey: string
    readonly list: typeof listModels
  },
  signal?: AbortSignal,
): Promise<{ readonly apiKey: string; readonly listing: ModelListingResult } | null> => {
  const listForKey = (apiKey: string) =>
    options.list(
      {
        provider: options.resolved.provider,
        apiKey,
        baseUrl: options.resolved.provider === 'openai-compat' ? options.resolved.baseUrl : undefined,
      },
      signal,
    )
  const first = await listForKey(options.initialApiKey)
  if (first.authenticated) return { apiKey: options.initialApiKey, listing: first }
  if (!first.wasAuthRejected) {
    io.write('Provider authentication could not be verified; saving as not authenticated.\n')
    return { apiKey: options.initialApiKey, listing: first }
  }

  io.write(`Provider rejected this API key (${first.status}) — check it.\n`)
  const isLocal = options.choice.kind === 'compat' && options.choice.isLocal
  const retriedApiKey = await readManagerSecret(io, isLocal ? 'API key [local]: ' : 'API key: ', isLocal)
  if (retriedApiKey === null) return null
  const second = await listForKey(retriedApiKey)
  const message = second.wasAuthRejected
    ? `Provider rejected this API key too (${second.status}); saving as authentication required.\n`
    : !second.authenticated
      ? 'Provider authentication could not be verified; saving as not authenticated.\n'
      : undefined
  if (message !== undefined) io.write(message)
  return { apiKey: retriedApiKey, listing: second }
}

const statusOf = (listing: ModelListingResult): ByokProfile['credentialStatus'] => {
  if (listing.authenticated) return 'authenticated'
  return listing.wasAuthRejected ? 'authentication-required' : 'not-authenticated'
}

/** Builds the provider-specific profile shape shared by create and repair flows. */
const assembleProfile = (options: {
  readonly id: string
  readonly label: string
  readonly resolved: ResolvedProvider
  readonly model: string
  readonly apiKey: string
  readonly listing: ModelListingResult
  readonly modelApi?: 'anthropic-messages' | 'openai-completions'
}): CollectedByokProfile => {
  const base = {
    id: options.id,
    label: options.label,
    defaultModel: options.model,
    apiKey: options.apiKey,
    credentialStatus: statusOf(options.listing),
  }
  if (options.resolved.provider === 'openai-compat') {
    return { profile: { ...base, provider: 'openai-compat', baseUrl: options.resolved.baseUrl }, apiKey: options.apiKey }
  }
  if (options.resolved.provider === 'fireworks') {
    return { profile: { ...base, provider: 'fireworks', modelApi: options.modelApi }, apiKey: options.apiKey }
  }
  return { profile: { ...base, provider: options.resolved.provider }, apiKey: options.apiKey }
}

/** Collects a new BYOK profile without persisting credentials before live activation. */
export const collectByokProfile = async (
  io: ProviderManagerIO,
  dependencies: CollectByokProfileDependencies = {},
  signal?: AbortSignal,
): Promise<CollectedByokProfile | null> => {
  const choiceId = await io.choose(
    'Provider API key',
    providerChoices.map(({ id, label }) => ({ id, label })),
  )
  if (choiceId === null) return null
  const choice = providerChoices.find(({ id }) => id === choiceId)
  if (choice === undefined) throw new Error(`Unknown provider choice "${choiceId}".`)

  const defaultLabel = choice.label.replace(/ \(local\)$/, '')
  const enteredLabel = await io.readText(`Profile name [${defaultLabel}]: `)
  if (enteredLabel === null) return null
  const label = enteredLabel.trim() || defaultLabel
  const resolved = await resolveManagerChoice(io, choice)
  if (resolved === null) return null
  const isLocal = choice.kind === 'compat' && choice.isLocal
  const initialApiKey = await readManagerSecret(io, isLocal ? 'API key [local]: ' : 'API key: ', isLocal)
  if (initialApiKey === null) return null
  const listed = await listManagerModels(
    io,
    {
      choice,
      resolved,
      initialApiKey,
      list: dependencies.list ?? listModels,
    },
    signal,
  )
  if (listed === null) return null
  const model = await chooseManagerModel(io, choice, listed.listing)
  if (model === null) return null
  const modelApi = resolved.provider === 'fireworks' ? await fireworksModelApi(io, model) : undefined
  if (modelApi === null) return null

  return assembleProfile({
    id: `byok-${randomUUID()}`,
    label,
    resolved,
    model,
    apiKey: listed.apiKey,
    listing: listed.listing,
    modelApi,
  })
}

/** Collects replacement credentials for one snapshot row without reading its old secret. */
export const collectByokRepair = async (
  io: ProviderManagerIO,
  selected: ProviderSnapshot['providers'][number],
  dependencies: CollectByokProfileDependencies = {},
  signal?: AbortSignal,
): Promise<CollectedByokProfile | null> => {
  if (selected.provider !== 'openai-compat' && !isBuiltinProvider(selected.provider)) {
    throw new Error(`Unsupported BYOK provider "${selected.provider}".`)
  }

  const initialApiKey = await readManagerSecret(io, 'Replacement API key: ', false)
  if (initialApiKey === null) return null
  const choice =
    selected.provider === 'openai-compat'
      ? ({
          id: 'compat:custom',
          kind: 'compat',
          label: 'Custom OpenAI-compatible endpoint',
          isLocal: false,
        } as const)
      : providerChoices.find(
          (candidate): candidate is BuiltinChoice =>
            candidate.kind === 'builtin' && candidate.provider === selected.provider,
        )
  if (choice === undefined) throw new Error(`Unsupported BYOK provider "${selected.provider}".`)
  const resolved = await resolveManagerChoice(io, choice)
  if (resolved === null) return null
  const listed = await listManagerModels(
    io,
    {
      choice,
      resolved,
      initialApiKey,
      list: dependencies.list ?? listModels,
    },
    signal,
  )
  if (listed === null) return null
  const modelApi =
    selected.provider === 'fireworks'
      ? (selected.modelApi ?? (await fireworksModelApi(io, selected.defaultModel)))
      : undefined
  if (modelApi === null) return null

  return assembleProfile({
    id: selected.id,
    label: selected.label,
    resolved,
    model: selected.defaultModel,
    apiKey: listed.apiKey,
    listing: listed.listing,
    modelApi,
  })
}
