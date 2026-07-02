/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the `runAgent` pre-flight guard: the anthropic provider (the
 * default) refuses to start without `ANTHROPIC_API_KEY`, and the guard keys off
 * the *resolved* provider (undefined → anthropic) so it fires before any harness
 * is built. Only this fail-fast branch is unit-tested; the success path drives a
 * live model and belongs to integration coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runAgent, shouldUseTui } from './run.ts'
import type { RunConfig } from './types.ts'

const KEY = 'ANTHROPIC_API_KEY'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
  delete process.env[KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

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

describe('runAgent — ANTHROPIC_API_KEY guard', () => {
  test('throws a friendly error for the explicit anthropic provider with no key', async () => {
    await expect(runAgent(oneshot({ provider: 'anthropic' }))).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  test('the default (unset) provider also requires the key', async () => {
    // provider omitted → `?? 'anthropic'` → same guard fires.
    await expect(runAgent(oneshot({ provider: undefined }))).rejects.toThrow(/set ANTHROPIC_API_KEY/)
  })

  test('openai-compat skips the anthropic guard — it fails on its own missing config instead', async () => {
    // The inverse branch: with no ANTHROPIC_API_KEY set, an anthropic run throws the
    // key error, but openai-compat must get past the guard and fail downstream in
    // model resolution (missing --base-url) — proving the provider condition matters.
    await expect(
      runAgent(oneshot({ provider: 'openai-compat', baseUrl: undefined, apiKey: undefined })),
    ).rejects.toThrow(/base-url/)
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
