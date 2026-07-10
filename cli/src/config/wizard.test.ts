/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { RunConfig } from '../agent/types.ts'
import { parseArgs } from '../cli.ts'
import type { CliConfig } from './config.ts'
import { runSetupWizard, shouldRunSetupWizard } from './wizard.ts'
import type { SetupWizardIO } from './wizard.ts'

/** Builds a resolved run configuration for pure setup-decision tests. */
const runConfig = (overrides: Partial<RunConfig> = {}): RunConfig =>
  ({
    model: 'claude-opus-4-8',
    cwd: '/repo',
    yolo: false,
    thinking: 'medium',
    provider: 'anthropic',
    mode: 'repl',
    noTui: false,
    ...overrides,
  }) as RunConfig

/** Builds default TTY runtime facts with targeted overrides. */
const runtime = (
  overrides: Partial<{
    readonly stdinIsTty: boolean
    readonly stdoutIsTty: boolean
    readonly env: Readonly<Record<string, string | undefined>>
  }> = {},
) => ({ stdinIsTty: true, stdoutIsTty: true, env: {}, ...overrides })

/** Creates setup I/O backed by independent visible and secret answer queues. */
const scriptedIO = (lines: readonly string[], secrets: readonly string[]) => {
  const remainingLines = [...lines]
  const remainingSecrets = [...secrets]
  const output: string[] = []
  const io: SetupWizardIO = {
    readLine: async () => remainingLines.shift() ?? null,
    readSecret: async () => remainingSecrets.shift() ?? null,
    write: (text) => output.push(text),
  }
  return { io, output }
}

describe('shouldRunSetupWizard', () => {
  test('uses setup for a credential-less run when stdin and stdout are TTYs', () => {
    expect(shouldRunSetupWizard(runConfig(), runtime())).toBe(true)
  })

  test('does not use setup when either terminal stream is not a TTY', () => {
    expect(shouldRunSetupWizard(runConfig(), runtime({ stdinIsTty: false }))).toBe(false)
    expect(shouldRunSetupWizard(runConfig(), runtime({ stdoutIsTty: false }))).toBe(false)
  })

  test('does not use setup when an explicit or saved key is resolved', () => {
    expect(shouldRunSetupWizard(runConfig({ apiKey: 'resolved-key' }), runtime())).toBe(false)
  })

  test('recognizes selected built-in provider environment credentials', () => {
    expect(
      shouldRunSetupWizard(runConfig({ provider: 'google' }), runtime({ env: { GEMINI_API_KEY: 'env-key' } })),
    ).toBe(false)
  })

  test('custom endpoints recognize only the dedicated environment key', () => {
    const custom = runConfig({ provider: 'openai-compat', baseUrl: 'https://host/v1' })
    expect(
      shouldRunSetupWizard(custom, runtime({ env: { THUNDERBOLT_OPENAI_COMPAT_KEY: 'custom-key' } })),
    ).toBe(false)
    expect(shouldRunSetupWizard(custom, runtime({ env: { OPENAI_API_KEY: 'real-openai-key' } }))).toBe(true)
  })
})

describe('runSetupWizard', () => {
  test('saves a built-in vendor, hidden key, and default model from scripted answers', async () => {
    const { io, output } = scriptedIO(['2', ''], ['sk-openai'])
    const saved: CliConfig[] = []

    const result = await runSetupWizard(io, {
      path: '/tmp/thunderbolt/config.json',
      save: async (config) => {
        saved.push(config)
      },
      catalogIds: () => ['gpt-catalog-a', 'gpt-catalog-b'],
    })

    const expected: CliConfig = { provider: 'openai', model: 'gpt-5.3-codex', apiKey: 'sk-openai' }
    expect(result).toEqual(expected)
    expect(saved).toEqual([expected])
    expect(output.join('')).toContain('2. OpenAI')
    expect(output.join('')).toContain('gpt-catalog-a')
    expect(output.join('')).toContain('Saved config to /tmp/thunderbolt/config.json')
  })

  test('uses Ollama preset URL and a placeholder key when secret input is blank', async () => {
    const { io } = scriptedIO(['15', 'qwen3-coder'], [''])
    const saved: CliConfig[] = []

    await runSetupWizard(io, {
      path: '/tmp/config.json',
      save: async (config) => {
        saved.push(config)
      },
      catalogIds: () => [],
    })

    expect(saved).toEqual([
      {
        provider: 'openai-compat',
        model: 'qwen3-coder',
        apiKey: 'local',
        baseUrl: 'http://localhost:11434/v1',
      },
    ])
  })

  test('prompts custom endpoints for base URL, key, and free-form model', async () => {
    const { io } = scriptedIO(['17', 'https://custom.example/v1', 'custom-model'], ['custom-key'])
    const saved: CliConfig[] = []

    await runSetupWizard(io, {
      path: '/tmp/config.json',
      save: async (config) => {
        saved.push(config)
      },
      catalogIds: () => [],
    })

    expect(saved).toEqual([
      {
        provider: 'openai-compat',
        model: 'custom-model',
        apiKey: 'custom-key',
        baseUrl: 'https://custom.example/v1',
      },
    ])
  })

  test('re-prompts when a choice conflicts with an explicit provider flag', async () => {
    const { io, output } = scriptedIO(['2', '3', ''], ['google-key'])
    const saved: CliConfig[] = []

    const freshConfig = await runSetupWizard(io, {
      path: '/tmp/config.json',
      requiredProvider: 'google',
      save: async (config) => {
        saved.push(config)
      },
      catalogIds: () => [],
    })

    expect(saved).toEqual([{ provider: 'google', model: 'gemini-3.1-pro-preview', apiKey: 'google-key' }])
    expect(output.join('')).toContain('--provider google overrides that choice')
    const reparsed = parseArgs(['--provider', 'google'], { config: freshConfig, env: {} })
    if (reparsed.kind !== 'run') throw new Error(`expected run, got ${reparsed.kind}`)
    expect(reparsed.config.apiKey).toBe('google-key')
    expect(reparsed.config.model).toBe('gemini-3.1-pro-preview')
  })
})
