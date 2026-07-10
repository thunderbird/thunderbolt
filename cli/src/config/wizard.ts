/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** First-run provider setup and its injectable terminal I/O seam. */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { BUILTIN_PROVIDER_ENV_VARS, DEFAULT_MODELS, DEFAULT_PROVIDER } from '../agent/defaults.ts'
import type { BuiltinProvider, ModelProvider, RunConfig } from '../agent/types.ts'
import { configPath } from '../paths.ts'
import { saveConfig } from './config.ts'
import type { CliConfig } from './config.ts'

type BuiltinChoice = {
  readonly kind: 'builtin'
  readonly label: string
  readonly provider: BuiltinProvider
}

type CompatChoice = {
  readonly kind: 'compat'
  readonly label: string
  readonly baseUrl?: string
  readonly local: boolean
}

type ProviderChoice = BuiltinChoice | CompatChoice

const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  { kind: 'builtin', label: 'Anthropic', provider: 'anthropic' },
  { kind: 'builtin', label: 'OpenAI', provider: 'openai' },
  { kind: 'builtin', label: 'Google (Gemini)', provider: 'google' },
  { kind: 'builtin', label: 'xAI (Grok)', provider: 'xai' },
  { kind: 'builtin', label: 'DeepSeek', provider: 'deepseek' },
  { kind: 'builtin', label: 'Z.AI', provider: 'zai' },
  { kind: 'builtin', label: 'Moonshot (Kimi)', provider: 'moonshotai' },
  { kind: 'builtin', label: 'Mistral', provider: 'mistral' },
  { kind: 'builtin', label: 'Groq', provider: 'groq' },
  { kind: 'builtin', label: 'Cerebras', provider: 'cerebras' },
  { kind: 'builtin', label: 'OpenRouter', provider: 'openrouter' },
  { kind: 'builtin', label: 'Together', provider: 'together' },
  { kind: 'builtin', label: 'Fireworks', provider: 'fireworks' },
  { kind: 'builtin', label: 'MiniMax', provider: 'minimax' },
  { kind: 'compat', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', local: true },
  { kind: 'compat', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', local: true },
  { kind: 'compat', label: 'Custom OpenAI-compatible endpoint', local: false },
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
  readonly catalogIds?: (provider: BuiltinProvider) => readonly string[]
  readonly requiredProvider?: ModelProvider
}

/** Runtime terminal and environment facts used by setup mode selection. */
export type SetupWizardRuntime = {
  readonly stdinIsTty: boolean
  readonly stdoutIsTty: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Reports whether selected provider has an explicit/config key or supported env credential. */
export const hasUsableCredentials = (
  config: Pick<RunConfig, 'provider' | 'apiKey'>,
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  if (config.apiKey) return true
  const provider = config.provider ?? DEFAULT_PROVIDER
  if (provider === 'openai-compat') return Boolean(env.THUNDERBOLT_OPENAI_COMPAT_KEY)
  return BUILTIN_PROVIDER_ENV_VARS[provider].some((name) => Boolean(env[name]))
}

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
  PROVIDER_CHOICES.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}\n`))

  while (true) {
    const answer = await io.readLine(`Provider [1-${PROVIDER_CHOICES.length}]: `)
    if (answer === null) throw new Error('Setup cancelled.')
    const index = Number(answer.trim()) - 1
    const choice = PROVIDER_CHOICES[index]
    if (!Number.isInteger(index) || choice === undefined) {
      io.write(`Enter a number from 1 to ${PROVIDER_CHOICES.length}.\n`)
      continue
    }
    if (requiredProvider === undefined || choiceProvider(choice) === requiredProvider) return choice
    io.write(`--provider ${requiredProvider} overrides that choice. Select ${requiredProvider}.\n`)
  }
}

/** Reads a hidden key, allowing local servers to use a non-empty placeholder. */
const readApiKey = async (io: SetupWizardIO, local: boolean): Promise<string> => {
  while (true) {
    const answer = await io.readSecret(local ? 'API key [local]: ' : 'API key: ')
    if (answer === null) throw new Error('Setup cancelled.')
    if (answer.trim() !== '') return answer.trim()
    if (local) return 'local'
    io.write('API key required.\n')
  }
}

/** Builds unique default-first model suggestions from Pi catalog ids. */
const modelChoices = (provider: BuiltinProvider, catalogIds: readonly string[]): readonly string[] =>
  [...new Set([DEFAULT_MODELS[provider], ...catalogIds])].slice(0, 4)

/** Reads a built-in model, accepting Enter for default, number, or free-form id. */
const chooseBuiltinModel = async (
  io: SetupWizardIO,
  provider: BuiltinProvider,
  catalogIds: readonly string[],
): Promise<string> => {
  const choices = modelChoices(provider, catalogIds)
  io.write('Available models:\n')
  choices.forEach((model, index) => io.write(`  ${index + 1}. ${model}${index === 0 ? ' (default)' : ''}\n`))
  const answer = await io.readLine(`Model [${DEFAULT_MODELS[provider]}]: `)
  if (answer === null) throw new Error('Setup cancelled.')
  if (answer.trim() === '') return DEFAULT_MODELS[provider]
  const numbered = choices[Number(answer.trim()) - 1]
  return numbered ?? answer.trim()
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
  const apiKey = await readApiKey(io, choice.kind === 'compat' && choice.local)
  const catalogIds =
    dependencies.catalogIds ??
    ((provider) =>
      builtinModels()
        .getModels(provider)
        .slice(0, 3)
        .map(({ id }) => id))
  const model =
    choice.kind === 'builtin'
      ? await chooseBuiltinModel(io, choice.provider, catalogIds(choice.provider))
      : await readRequiredLine(io, 'Model id: ')
  const config: CliConfig = {
    provider: resolved.provider,
    model,
    apiKey,
    ...(resolved.baseUrl === undefined ? {} : { baseUrl: resolved.baseUrl }),
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
  const question = async (prompt: string, secret: boolean): Promise<string | null> => {
    if (secret) {
      output.write(prompt)
      state.muted = true
    }
    try {
      const answer = await rl.question(secret ? '' : prompt, { signal: eof.signal })
      return answer.trim()
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null
      throw error
    } finally {
      if (secret) {
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
