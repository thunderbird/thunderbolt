/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for `buildSystemPrompt` — specifically the `modelId` branch that
 * powers the ACP "self-identify" feature: the model is named only when an id is
 * passed, and the working directory is always interpolated.
 */

import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from './system-prompt.ts'

describe('buildSystemPrompt', () => {
  test('names the model when a modelId is provided', () => {
    expect(buildSystemPrompt({ cwd: '/work', modelId: 'claude-opus-4-8' })).toContain('powered by claude-opus-4-8')
  })

  test('omits the "powered by" clause when no modelId is given', () => {
    expect(buildSystemPrompt({ cwd: '/work' })).not.toContain('powered by')
  })

  test('always interpolates the working directory', () => {
    expect(buildSystemPrompt({ cwd: '/home/me/project' })).toContain('Working directory: /home/me/project')
  })

  test('describes bash only when shell execution is enabled', () => {
    expect(buildSystemPrompt({ cwd: '/work' })).toContain('- bash')

    const jailedPrompt = buildSystemPrompt({ cwd: '/work', bashEnabled: false })
    expect(jailedPrompt).toContain('four tools')
    expect(jailedPrompt).not.toContain('- bash')
    expect(jailedPrompt).not.toContain('Prefer bash')
  })

  test('describes web-access priority and reserves curl for permission-gated fallback', () => {
    const prompt = buildSystemPrompt({ cwd: '/work' })
    const ladder = prompt.slice(prompt.indexOf('Web access priority:'))
    const search = ladder.indexOf('web_search')
    const fetch = ladder.indexOf('webfetch')
    const curl = ladder.indexOf('curl')

    expect(search).toBeGreaterThan(-1)
    expect(fetch).toBeGreaterThan(search)
    expect(curl).toBeGreaterThan(fetch)
    expect(ladder.slice(search, curl)).toMatch(/when available/i)
    expect(ladder.slice(curl)).toMatch(/last resort/i)
    expect(ladder.slice(curl)).toMatch(/permission/i)
    expect(prompt).not.toMatch(/no web access/i)
  })
})
