/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** First-run provider setup and its injectable terminal I/O seam. */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { defaultModels, defaultProvider, hasProviderEnvKey } from '../agent/defaults.ts'
import type { BuiltinProvider, ModelProvider, RunConfig } from '../agent/types.ts'
import { configPath } from '../paths.ts'
import { saveConfig } from './config.ts'
import type { CliConfig } from './config.ts'
import { listModels } from './model-listing.ts'
import type { ModelListingFetch, ModelListingResult } from './model-listing.ts'

type BuiltinChoice = {
  readonly kind: 'builtin'
  readonly label: string
  readonly provider: BuiltinProvider
}

type CompatChoice = {
  readonly kind: 'compat'
  readonly label: string
  readonly baseUrl?: string
  readonly isLocal: boolean
}

type ProviderChoice = BuiltinChoice | CompatChoice

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
    (provider): BuiltinChoice => ({ kind: 'builtin', label: builtinProviderLabels[provider], provider }),
  ),
  { kind: 'compat', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', isLocal: true },
  { kind: 'compat', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', isLocal: true },
  { kind: 'compat', label: 'Custom OpenAI-compatible endpoint', isLocal: false },
]

/** Interactive operations consumed by setup; tests provide scripted answers. */
export type SetupWizardIO = {
  readonly readLine: (prompt: string) => Promise<string | null>
  readonly readSecret: (prompt: string) => Promise<string | null>
  readonly write: (text: string) => void
}

/** Production setup I/O includes lifecycle cleanup for its readline handle. */
export type SetupWizardTerminalIO = SetupWizardIO & { readonly close: () => void }

type SetupWizardDependencies = {
  readonly path?: string
  readonly save?: (config: CliConfig, path: string) => Promise<void>
  readonly fetchFn?: ModelListingFetch
  readonly modelListingTimeoutMs?: number
  readonly requiredProvider?: ModelProvider
}

/** Runtime terminal and environment facts used by setup mode selection. */
export type SetupWizardRuntime = {
  readonly stdinIsTty: boolean
  readonly stdoutIsTty: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Reports whether selected provider has an explicit/config key or supported env credential. */
const hasUsableCredentials = (
  config: Pick<RunConfig, 'provider' | 'apiKey'>,
  env: Readonly<Record<string, string | undefined>>,
): boolean => Boolean(config.apiKey) || hasProviderEnvKey(config.provider ?? defaultProvider, env)

/** Selects guided setup only for credential-less runs owning stdin and stdout TTYs. */
export const shouldRunSetupWizard = (config: RunConfig, runtime: SetupWizardRuntime): boolean =>
  runtime.stdinIsTty && runtime.stdoutIsTty && !hasUsableCredentials(config, runtime.env)

/** Reads one required value, retrying blank input and surfacing EOF as cancellation. */
const readRequiredLine = async (io: SetupWizardIO, prompt: string): Promise<string> => {
  while (true) {
    const answer = await io.readLine(prompt)
    if (answer === null) throw new Error('Setup cancelled.')
    if (answer.trim() !== '') return answer.trim()
    io.write('Value required.\n')
  }
}

/** Resolves one menu choice to its effective provider id. */
const choiceProvider = (choice: ProviderChoice): ModelProvider =>
  choice.kind === 'builtin' ? choice.provider : 'openai-compat'

/** Prints ordered provider menu and reads a valid provider-compatible choice. */
const chooseProvider = async (io: SetupWizardIO, requiredProvider?: ModelProvider): Promise<ProviderChoice> => {
  io.write('Choose a model provider:\n')
  providerChoices.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}\n`))

  while (true) {
    const answer = await io.readLine(`Provider [1-${providerChoices.length}]: `)
    if (answer === null) throw new Error('Setup cancelled.')
    // Digits-only so `0x2`/`2e0` don't coerce into a menu choice.
    const text = answer.trim()
    const choice = /^\d+$/.test(text) ? providerChoices[Number(text) - 1] : undefined
    if (choice === undefined) {
      io.write(`Enter a number from 1 to ${providerChoices.length}.\n`)
      continue
    }
    if (requiredProvider === undefined || choiceProvider(choice) === requiredProvider) return choice
    io.write(`--provider ${requiredProvider} overrides that choice. Select ${requiredProvider}.\n`)
  }
}

/** Reads a hidden key, allowing local servers to use a non-empty placeholder. */
const readApiKey = async (io: SetupWizardIO, isLocal: boolean): Promise<string> => {
  while (true) {
    const answer = await io.readSecret(isLocal ? 'API key [local]: ' : 'API key: ')
    if (answer === null) throw new Error('Setup cancelled.')
    if (answer.trim() !== '') return answer.trim()
    if (isLocal) return 'local'
    io.write('API key required.\n')
  }
}

/** Builds unique default-first model suggestions from live or Pi catalog ids. */
const modelChoices = (provider: BuiltinProvider, ids: readonly string[]): readonly string[] => [
  ...new Set([defaultModels[provider], ...ids]),
]

/** Resolves a non-empty menu answer: a listed choice for an in-range number,
 *  the answer itself as a free-form model id when non-numeric, or `null` for an
 *  out-of-range number so callers re-prompt instead of persisting a digit. */
const resolveModelAnswer = (answer: string, choices: readonly string[]): string | null => {
  if (!/^\d+$/.test(answer)) return answer
  return choices[Number(answer) - 1] ?? null
}

/** Prompts until the answer resolves to a listed number or a free-form model
 *  id. An empty answer returns `defaultId` when one exists, else re-prompts. */
const promptModelChoice = async (
  io: SetupWizardIO,
  prompt: string,
  choices: readonly string[],
  defaultId: string | null,
): Promise<string> => {
  while (true) {
    const answer = await io.readLine(prompt)
    if (answer === null) throw new Error('Setup cancelled.')
    const text = answer.trim()
    if (text === '') {
      if (defaultId !== null) return defaultId
      io.write('Value required.\n')
      continue
    }
    const resolved = resolveModelAnswer(text, choices)
    if (resolved !== null) return resolved
    io.write(`Enter a number from 1 to ${choices.length}, or a model id.\n`)
  }
}

/** Reads a built-in model, accepting Enter for default, number, or free-form id. */
const chooseBuiltinModel = async (
  io: SetupWizardIO,
  provider: BuiltinProvider,
  listing: ModelListingResult,
): Promise<string> => {
  const choices = modelChoices(provider, listing.ids)
  io.write(listing.source === 'catalog' ? 'Available models (offline list):\n' : 'Available models:\n')
  choices.forEach((model, index) => io.write(`  ${index + 1}. ${model}${index === 0 ? ' (default)' : ''}\n`))
  return promptModelChoice(io, `Model [${defaultModels[provider]}]: `, choices, defaultModels[provider])
}

/** Reads a numbered or free-form model id for a custom compatible endpoint. */
const chooseCompatModel = async (io: SetupWizardIO, listing: ModelListingResult): Promise<string> => {
  if (listing.source === 'catalog') {
    // The Pi catalog has no ids for a custom endpoint, so there is no list to
    // show — say so instead of printing an empty header.
    io.write('Could not fetch a live model list from this endpoint.\n')
    return readRequiredLine(io, 'Model id: ')
  }

  const choices = [...new Set(listing.ids)]
  io.write('Available models:\n')
  choices.forEach((model, index) => io.write(`  ${index + 1}. ${model}\n`))
  return promptModelChoice(io, 'Model id or number: ', choices, null)
}

type ApiKeyAndListing = {
  readonly apiKey: string
  readonly listing: ModelListingResult
}

type KeyRetryOptions = {
  readonly provider: ModelProvider
  readonly initialApiKey: string
  readonly baseUrl?: string
  readonly isLocal: boolean
  readonly dependencies: SetupWizardDependencies
}

/** Lists models and allows one key correction after provider authentication rejection. */
const listModelsWithKeyRetry = async (io: SetupWizardIO, options: KeyRetryOptions): Promise<ApiKeyAndListing> => {
  const listForKey = (key: string) =>
    listModels({
      provider: options.provider,
      apiKey: key,
      baseUrl: options.baseUrl,
      fetchFn: options.dependencies.fetchFn,
      timeoutMs: options.dependencies.modelListingTimeoutMs,
    })
  const firstListing = await listForKey(options.initialApiKey)
  if (!firstListing.wasAuthRejected) return { apiKey: options.initialApiKey, listing: firstListing }

  io.write(`Provider rejected this API key (${firstListing.status}) — check it.\n`)
  const retriedApiKey = await readApiKey(io, options.isLocal)
  const secondListing = await listForKey(retriedApiKey)
  if (secondListing.wasAuthRejected) {
    // Persisted anyway so setup completes; be explicit that the key is bad.
    io.write(
      `Provider rejected this API key too (${secondListing.status}) — saving it anyway; run \`thunderbolt config\` to fix it.\n`,
    )
  }
  return { apiKey: retriedApiKey, listing: secondListing }
}

/** Resolves selected choice into provider and optional custom base URL. */
const resolveChoice = async (
  choice: ProviderChoice,
  io: SetupWizardIO,
): Promise<{ readonly provider: ModelProvider; readonly baseUrl?: string }> => {
  if (choice.kind === 'builtin') return { provider: choice.provider }
  if (choice.baseUrl !== undefined) return { provider: 'openai-compat', baseUrl: choice.baseUrl }
  return { provider: 'openai-compat', baseUrl: await readRequiredLine(io, 'Base URL: ') }
}

/** Runs setup, securely persists selected profile, and returns it for immediate reuse. */
export const runSetupWizard = async (
  io: SetupWizardIO,
  dependencies: SetupWizardDependencies = {},
): Promise<CliConfig> => {
  const choice = await chooseProvider(io, dependencies.requiredProvider)
  const resolved = await resolveChoice(choice, io)
  const isLocal = choice.kind === 'compat' && choice.isLocal
  const initialApiKey = await readApiKey(io, isLocal)
  const { apiKey, listing } = await listModelsWithKeyRetry(io, {
    provider: resolved.provider,
    initialApiKey,
    baseUrl: resolved.baseUrl,
    isLocal,
    dependencies,
  })
  const model =
    choice.kind === 'builtin'
      ? await chooseBuiltinModel(io, choice.provider, listing)
      : await chooseCompatModel(io, listing)
  const config: CliConfig = {
    provider: resolved.provider,
    model,
    apiKey,
    baseUrl: resolved.baseUrl,
  }
  const path = dependencies.path ?? configPath()
  await (dependencies.save ?? saveConfig)(config, path)
  io.write(`Saved config to ${path}.\n`)
  return config
}

/** Creates readline setup I/O while suppressing terminal echo for secret input. */
export const createSetupWizardIO = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): SetupWizardTerminalIO => {
  const state = { muted: false }
  const readlineOutput = new Writable({
    write: (chunk, _encoding, callback) => {
      if (!state.muted) output.write(chunk)
      callback()
    },
  })
  const rl = createInterface({ input, output: readlineOutput, terminal: true })
  const eof = new AbortController()
  rl.on('close', () => eof.abort())

  /** Reads one readline answer and maps only expected stream closure to EOF. */
  const question = async (prompt: string, isSecret: boolean): Promise<string | null> => {
    if (isSecret) {
      output.write(prompt)
      state.muted = true
    }
    try {
      const answer = await rl.question(isSecret ? '' : prompt, { signal: eof.signal })
      return answer.trim()
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null
      throw error
    } finally {
      if (isSecret) {
        state.muted = false
        output.write('\n')
      }
    }
  }

  return {
    readLine: (prompt) => question(prompt, false),
    readSecret: (prompt) => question(prompt, true),
    write: (text) => {
      output.write(text)
    },
    close: () => rl.close(),
  }
}
