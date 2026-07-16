/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Branch + edge-case coverage for `parseArgs` — the pure argv → ParsedArgs
 * folder. Focus areas: the openai-compat api-key precedence (flag wins over
 * `THUNDERBOLT_OPENAI_COMPAT_KEY`, and the key never bleeds into the prompt),
 * the value-validating flags, and the bridge/serve/connect subcommand routing.
 */

import { describe, expect, test } from 'bun:test'
import packageJson from '../package.json' with { type: 'json' }
import rootPackageJson from '../../package.json' with { type: 'json' }
import { parseArgs, VERSION } from './cli.ts'
import type { ParseArgsDependencies } from './cli.ts'
import { BUILTIN_PROVIDERS } from './agent/types.ts'
import type { CliConfig } from './config/config.ts'

const ENV_KEY = 'THUNDERBOLT_OPENAI_COMPAT_KEY'

test('VERSION and the CLI package match the released app version', () => {
  expect(VERSION).toBe(packageJson.version)
  expect(packageJson.version).toBe(rootPackageJson.version)
})

/** Narrow a ParsedArgs to a `run` config or fail loudly. */
const runConfig = (argv: string[], dependencies?: ParseArgsDependencies) => {
  const parsed = parseArgs(argv, dependencies)
  if (parsed.kind !== 'run') throw new Error(`expected run, got ${parsed.kind}: ${JSON.stringify(parsed)}`)
  return parsed.config
}

describe('parseArgs — resolveApiKey precedence (security)', () => {
  test('--api-key flag wins over the env var', () => {
    const config = runConfig(
      ['--provider', 'openai-compat', '--base-url', 'https://h/v1', '--api-key', 'flag-key', 'hi'],
      { env: { [ENV_KEY]: 'env-key' } },
    )
    expect(config.apiKey).toBe('flag-key')
  })

  test('falls back to the env var when no flag is given', () => {
    const config = runConfig(['--provider', 'openai-compat', '--base-url', 'https://h/v1', 'hi'], {
      env: { [ENV_KEY]: 'env-key' },
    })
    expect(config.apiKey).toBe('env-key')
  })

  test('is undefined when neither flag nor env is set', () => {
    const config = runConfig(['--provider', 'openai-compat', '--base-url', 'https://h/v1', 'hi'], { env: {} })
    expect(config.apiKey).toBeUndefined()
  })

  test('does not auto-forward a standard OPENAI_API_KEY (dedicated var only)', () => {
    const config = runConfig(['--provider', 'openai-compat', '--base-url', 'https://h/v1', 'hi'], {
      env: { OPENAI_API_KEY: 'sk-real-openai' },
    })
    expect(config.apiKey).toBeUndefined()
  })

  test('does not forward the openai-compat env key to a built-in provider', () => {
    expect(runConfig(['--provider', 'openai', 'hi'], { env: { [ENV_KEY]: 'custom-host-key' } }).apiKey).toBeUndefined()
  })

  test('the api key never leaks into the prompt positionals', () => {
    const config = runConfig(['--api-key', 'super-secret', 'fix', 'the', 'bug'], { env: {} })
    if (config.mode !== 'oneshot') throw new Error('expected oneshot')
    expect(config.prompt).toBe('fix the bug')
    expect(config.prompt).not.toContain('super-secret')
    expect(config.apiKey).toBe('super-secret')
  })

  test('an --api-key consumed at the end of argv does not become a positional prompt', () => {
    const config = runConfig(['hello', '--api-key', 'k'], { env: {} })
    if (config.mode !== 'oneshot') throw new Error('expected oneshot')
    expect(config.prompt).toBe('hello')
  })
})

describe('parseArgs — flag validation', () => {
  test('rejects an unknown --provider value', () => {
    const parsed = parseArgs(['--provider', 'gemini'])
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining("invalid --provider 'gemini'") })
  })

  test('rejects a --provider with no following value', () => {
    expect(parseArgs(['--provider'])).toEqual({ kind: 'error', message: 'thunderbolt: --provider requires a value' })
  })

  test('rejects an invalid --thinking level', () => {
    const parsed = parseArgs(['--thinking', 'ultra'])
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining("invalid --thinking level 'ultra'") })
  })

  test('reports the specific missing-value message for each value-taking flag', () => {
    expect(parseArgs(['--model'])).toEqual({ kind: 'error', message: 'thunderbolt: --model requires a value' })
    expect(parseArgs(['--base-url'])).toEqual({ kind: 'error', message: 'thunderbolt: --base-url requires a value' })
    expect(parseArgs(['--api-key'])).toEqual({ kind: 'error', message: 'thunderbolt: --api-key requires a value' })
    expect(parseArgs(['--thinking'])).toEqual({ kind: 'error', message: 'thunderbolt: --thinking requires a value' })
  })

  test('accepts a valid provider/thinking and threads them into the config', () => {
    const config = runConfig(['--provider', 'openai-compat', '--base-url', 'https://h/v1', '--thinking', 'high', 'go'])
    expect(config.provider).toBe('openai-compat')
    expect(config.thinking).toBe('high')
    expect(config.baseUrl).toBe('https://h/v1')
  })

  test('accepts every curated built-in provider', () => {
    for (const provider of BUILTIN_PROVIDERS) {
      expect(runConfig(['--provider', provider]).provider).toBe(provider)
    }
  })

  test('the -m alias sets the model just like --model', () => {
    expect(runConfig(['-m', 'claude-x', 'go']).model).toBe('claude-x')
  })
})

describe('parseArgs — defaults', () => {
  test('an empty argv yields the documented default config', () => {
    const config = runConfig([])
    expect(config.mode).toBe('repl')
    expect(config.model).toBe('claude-opus-4-8')
    expect(config.provider).toBe('anthropic')
    expect(config.thinking).toBe('medium')
    expect(config.yolo).toBe(false)
    expect(config.baseUrl).toBeUndefined()
  })

  test('uses provider-specific default models when --model is omitted', () => {
    const expected = {
      anthropic: 'claude-opus-4-8',
      openai: 'gpt-5.6-sol',
      google: 'gemini-3.1-pro-preview',
      xai: 'grok-build-0.1',
      deepseek: 'deepseek-v4-pro',
      zai: 'glm-5.2',
      mistral: 'devstral-medium-latest',
      groq: 'openai/gpt-oss-120b',
      openrouter: 'anthropic/claude-opus-4.8',
      moonshotai: 'kimi-k2.7-code',
      minimax: 'MiniMax-M3',
      cerebras: 'gpt-oss-120b',
      together: 'moonshotai/Kimi-K2.7-Code',
      fireworks: 'accounts/fireworks/models/kimi-k2p7-code',
    } as const

    for (const provider of BUILTIN_PROVIDERS) {
      expect(runConfig(['--provider', provider]).model).toBe(expected[provider])
    }
  })

  test('an explicit --model wins over the provider default', () => {
    expect(runConfig(['--provider', 'google', '--model', 'gemini-custom']).model).toBe('gemini-custom')
  })
})

describe('parseArgs — persisted config precedence', () => {
  const stored: CliConfig = {
    provider: 'openai-compat',
    model: 'saved-model',
    apiKey: 'saved-key',
    baseUrl: 'https://saved.example/v1',
  }

  test('uses saved provider, model, key, and base URL when flags and env are silent', () => {
    const config = runConfig([], { config: stored, env: {}, cwd: '/repo' })

    expect(config).toEqual({
      mode: 'repl',
      noTui: false,
      model: 'saved-model',
      cwd: '/repo',
      yolo: false,
      thinking: 'medium',
      provider: 'openai-compat',
      apiKey: 'saved-key',
      baseUrl: 'https://saved.example/v1',
    })
  })

  test('explicit flags override every saved field', () => {
    const config = runConfig(
      [
        '--provider',
        'anthropic',
        '--model',
        'flag-model',
        '--api-key',
        'flag-key',
        '--base-url',
        'https://flag.example/v1',
      ],
      { config: stored, env: {}, cwd: '/repo' },
    )

    expect(config.provider).toBe('anthropic')
    expect(config.model).toBe('flag-model')
    expect(config.apiKey).toBe('flag-key')
    expect(config.baseUrl).toBe('https://flag.example/v1')
  })

  test('matching built-in provider env suppresses saved-key injection so Pi owns env auth', () => {
    const config = runConfig([], {
      config: { provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'saved-key' },
      env: { OPENAI_API_KEY: 'env-key' },
    })

    expect(config.apiKey).toBeUndefined()
  })

  test('dedicated openai-compat env key wins over saved key', () => {
    const config = runConfig([], {
      config: stored,
      env: { THUNDERBOLT_OPENAI_COMPAT_KEY: 'env-key' },
    })

    expect(config.apiKey).toBe('env-key')
  })

  test('an empty dedicated env key is silent and falls back to saved key', () => {
    const config = runConfig([], {
      config: stored,
      env: { THUNDERBOLT_OPENAI_COMPAT_KEY: '' },
    })

    expect(config.apiKey).toBe('saved-key')
  })

  test('saved openai-compat key is not forwarded when --base-url targets a different endpoint', () => {
    const config = runConfig(['--base-url', 'https://other.example/v1'], { config: stored, env: {} })

    expect(config.baseUrl).toBe('https://other.example/v1')
    expect(config.apiKey).toBeUndefined()
  })

  test('saved openai-compat key is used when effective base URL matches saved endpoint', () => {
    const config = runConfig(['--base-url', 'https://saved.example/v1'], { config: stored, env: {} })

    expect(config.baseUrl).toBe('https://saved.example/v1')
    expect(config.apiKey).toBe('saved-key')
  })

  test('--api-key remains explicit opt-in when --base-url targets a different endpoint', () => {
    const config = runConfig(['--base-url', 'https://other.example/v1', '--api-key', 'flag-key'], {
      config: stored,
      env: {},
    })

    expect(config.apiKey).toBe('flag-key')
  })

  test('dedicated env key remains explicit opt-in when --base-url targets a different endpoint', () => {
    const config = runConfig(['--base-url', 'https://other.example/v1'], {
      config: stored,
      env: { THUNDERBOLT_OPENAI_COMPAT_KEY: 'env-key' },
    })

    expect(config.apiKey).toBe('env-key')
  })

  test('saved key and base URL do not cross provider boundaries', () => {
    const config = runConfig(['--provider', 'anthropic'], { config: stored, env: {} })

    expect(config.model).toBe('claude-opus-4-8')
    expect(config.apiKey).toBeUndefined()
    expect(config.baseUrl).toBeUndefined()
  })

  test('generic OpenAI env key never forwards to a saved custom endpoint', () => {
    const config = runConfig([], { config: stored, env: { OPENAI_API_KEY: 'real-openai-key' } })

    expect(config.apiKey).toBe('saved-key')
  })
})

describe('parseArgs — config subcommand', () => {
  test('routes thunderbolt config to interactive setup', () => {
    expect(parseArgs(['config'])).toEqual({ kind: 'config' })
  })

  test('rejects arguments after config', () => {
    expect(parseArgs(['config', 'extra'])).toEqual({
      kind: 'error',
      message: "thunderbolt config: unexpected argument 'extra'",
    })
  })
})

describe('parseArgs — run mode + yolo aliases', () => {
  test('no prompt yields repl mode; a prompt yields oneshot', () => {
    expect(parseArgs([]).kind).toBe('run')
    const repl = runConfig([])
    expect(repl.mode).toBe('repl')
    expect(runConfig(['do', 'it']).mode).toBe('oneshot')
  })

  test('strips a leading `agent` subcommand before scanning flags', () => {
    const config = runConfig(['agent', '--model', 'x', 'prompt'])
    expect(config.model).toBe('x')
    if (config.mode !== 'oneshot') throw new Error('expected oneshot')
    expect(config.prompt).toBe('prompt')
  })

  test('all three yolo spellings set the flag', () => {
    expect(runConfig(['-y', 'p']).yolo).toBe(true)
    expect(runConfig(['--yolo', 'p']).yolo).toBe(true)
    expect(runConfig(['--dangerously-skip-permissions', 'p']).yolo).toBe(true)
    expect(runConfig(['p']).yolo).toBe(false)
  })

  test('--no-tui sets noTui on a repl config; it defaults to false', () => {
    const off = runConfig(['--no-tui'])
    if (off.mode !== 'repl') throw new Error('expected repl')
    expect(off.noTui).toBe(true)
    const on = runConfig([])
    if (on.mode !== 'repl') throw new Error('expected repl')
    expect(on.noTui).toBe(false)
  })

  test('--help / --version short-circuit over a run', () => {
    expect(parseArgs(['--help', 'ignored']).kind).toBe('help')
    expect(parseArgs(['-h']).kind).toBe('help')
    expect(parseArgs(['--version']).kind).toBe('version')
    expect(parseArgs(['-v']).kind).toBe('version')
  })
})

describe('parseArgs — bridge subcommands (acp / mcp)', () => {
  test('parses a wss bridge with an explicit port and the post-`--` command', () => {
    const parsed = parseArgs(['acp', '--transport', 'wss', '--port', '9001', '--', 'npx', 'agent'])
    expect(parsed).toEqual({
      kind: 'bridge',
      config: { protocol: 'acp', transport: 'wss', port: 9001, command: ['npx', 'agent'] },
    })
  })

  test('defaults the port per protocol when omitted', () => {
    const acp = parseArgs(['acp', '--', 'cmd'])
    const mcp = parseArgs(['mcp', '--', 'cmd'])
    if (acp.kind !== 'bridge' || mcp.kind !== 'bridge') throw new Error('expected bridge')
    expect(acp.config.port).toBe(8839)
    expect(mcp.config.port).toBe(8840)
  })

  test('rejects an unknown --transport', () => {
    const parsed = parseArgs(['acp', '--transport', 'tcp', '--', 'cmd'])
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining("invalid --transport 'tcp'") })
  })

  test('rejects a non-numeric or out-of-range --port', () => {
    expect(parseArgs(['acp', '--port', '0x10', '--', 'cmd']).kind).toBe('error')
    expect(parseArgs(['acp', '--port', '70000', '--', 'cmd']).kind).toBe('error')
    expect(parseArgs(['acp', '--port', '1e3', '--', 'cmd']).kind).toBe('error')
  })

  test('treats an unrecognized pre-`--` token as a forgotten separator', () => {
    const parsed = parseArgs(['acp', 'npx', 'agent'])
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining("forget '--'") })
  })

  test('requires a command after the `--` separator', () => {
    const parsed = parseArgs(['mcp', '--transport', 'wss', '--'])
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining('missing agent command') })
  })

  test('missing separator entirely is a missing-command error', () => {
    expect(parseArgs(['acp']).kind).toBe('error')
  })
})

describe('parseArgs — acp serve', () => {
  test('resolves the same flag set as a run, including api-key precedence', () => {
    const parsed = parseArgs(
      ['acp', 'serve', '--provider', 'openai-compat', '--base-url', 'https://h/v1', '--api-key', 'flag-key'],
      { env: { [ENV_KEY]: 'env-key' } },
    )
    if (parsed.kind !== 'acp-serve') throw new Error(`expected acp-serve, got ${parsed.kind}`)
    expect(parsed.config.apiKey).toBe('flag-key')
    expect(parsed.config.provider).toBe('openai-compat')
  })

  test('rejects a stray positional (serve takes no prompt)', () => {
    const parsed = parseArgs(['acp', 'serve', 'unexpected'], { env: {} })
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining("unexpected argument 'unexpected'") })
  })

  test('uses the same provider-specific model default as agent runs', () => {
    const parsed = parseArgs(['acp', 'serve', '--provider', 'google'], { env: {} })
    if (parsed.kind !== 'acp-serve') throw new Error(`expected acp-serve, got ${parsed.kind}`)
    expect(parsed.config.model).toBe('gemini-3.1-pro-preview')
    expect(parsed.config.provider).toBe('google')
  })
})

describe('parseArgs — connect + iroh admin', () => {
  test('connect parses the dial target and post-`--` client command', () => {
    const parsed = parseArgs(['acp', 'connect', 'ticket123', '--', 'local', 'client'])
    expect(parsed).toEqual({
      kind: 'connect',
      config: { protocol: 'acp', target: 'ticket123', command: ['local', 'client'] },
    })
  })

  test('connect with only a target (no local command) yields an empty command', () => {
    expect(parseArgs(['mcp', 'connect', 'node-abc'])).toEqual({
      kind: 'connect',
      config: { protocol: 'mcp', target: 'node-abc', command: [] },
    })
  })

  test('connect passes --help through to the client command after the separator', () => {
    expect(parseArgs(['acp', 'connect', 'ticket123', '--', 'client', '--help'])).toEqual({
      kind: 'connect',
      config: { protocol: 'acp', target: 'ticket123', command: ['client', '--help'] },
    })
  })

  test('connect without a target is an error', () => {
    expect(parseArgs(['mcp', 'connect']).kind).toBe('error')
  })

  test('connect rejects a second bare token before `--`', () => {
    const parsed = parseArgs(['acp', 'connect', 'ticket', 'stray'])
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining("unexpected argument 'stray'") })
  })

  test('iroh allow requires a nodeid; id/pair route to admin actions', () => {
    expect(parseArgs(['iroh', 'id'])).toEqual({ kind: 'iroh-admin', action: { kind: 'id' } })
    expect(parseArgs(['iroh', 'pair'])).toEqual({ kind: 'iroh-admin', action: { kind: 'pair' } })
    expect(parseArgs(['iroh', 'allow', 'node-xyz'])).toEqual({
      kind: 'iroh-admin',
      action: { kind: 'allow', nodeId: 'node-xyz' },
    })
    expect(parseArgs(['iroh', 'allow']).kind).toBe('error')
    expect(parseArgs(['iroh', 'bogus']).kind).toBe('error')
  })
})
