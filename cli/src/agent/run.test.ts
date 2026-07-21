/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for provider-aware model preflight plus TUI mode selection. Success
 * paths drive live providers and belong to integration coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runAgent, shouldUseTui } from './run.ts'
import type { RunConfig } from './types.ts'

const KEYS = ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
const saved: Partial<Record<(typeof KEYS)[number], string>> = {}

beforeEach(() => {
  for (const key of KEYS) {
    const value = process.env[key]
    if (value !== undefined) saved[key] = value
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete saved[key]
  }
})

/** Builds a one-shot run configuration with targeted overrides. */
const oneshot = (overrides: Partial<RunConfig> = {}): RunConfig =>
  ({
    model: 'claude-opus-4-8',
    cwd: process.cwd(),
    yolo: false,
    thinking: 'medium',
    mode: 'oneshot',
    prompt: 'hi',
    ...overrides,
  }) as RunConfig

/** Builds a REPL run configuration with targeted overrides. */
const repl = (overrides: Partial<RunConfig> = {}): RunConfig =>
  ({
    model: 'claude-opus-4-8',
    cwd: process.cwd(),
    yolo: false,
    thinking: 'medium',
    mode: 'repl',
    noTui: false,
    ...overrides,
  }) as RunConfig

describe('runAgent — provider credential preflight', () => {
  test('throws a friendly error for the explicit anthropic provider with no key', async () => {
    await expect(runAgent(oneshot({ provider: 'anthropic' }))).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  test('the default (unset) provider also requires the key', async () => {
    await expect(runAgent(oneshot({ provider: undefined }))).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  test('openai-compat reports its dedicated key and guided setup when credentials are missing', async () => {
    await expect(
      runAgent(oneshot({ provider: 'openai-compat', baseUrl: undefined, apiKey: undefined })),
    ).rejects.toThrow(/THUNDERBOLT_OPENAI_COMPAT_KEY.*guided setup/)
  })
})

describe('shouldUseTui — REPL mode selection', () => {
  test('a REPL on a TTY with no opt-out uses the TUI', () => {
    expect(shouldUseTui(repl(), { isTty: true, noTuiEnv: false })).toBe(true)
  })

  test('a piped (non-TTY) REPL falls back to the plain loop', () => {
    expect(shouldUseTui(repl(), { isTty: false, noTuiEnv: false })).toBe(false)
  })

  test('THUNDERBOLT_NO_TUI forces the plain loop even on a TTY', () => {
    expect(shouldUseTui(repl(), { isTty: true, noTuiEnv: true })).toBe(false)
  })

  test('the --no-tui flag forces the plain loop even on a TTY', () => {
    expect(shouldUseTui(repl({ noTui: true }), { isTty: true, noTuiEnv: false })).toBe(false)
  })

  test('oneshot runs never use the TUI, even on a TTY', () => {
    expect(shouldUseTui(oneshot(), { isTty: true, noTuiEnv: false })).toBe(false)
  })
})
