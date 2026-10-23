/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { supportsPiCompaction } from './built-in-model-support'

describe('supportsPiCompaction', () => {
  it.each(['claude-opus-4-8', 'claude-sonnet-4-6'])('supports catalog model %s', (model) => {
    expect(supportsPiCompaction(createMockModel({ provider: 'anthropic', model, toolUsage: 1 }))).toBe(true)
  })

  it.each(['unlisted-model', 'constructor', '__proto__'])('rejects unknown Anthropic model %s', (model) => {
    expect(supportsPiCompaction(createMockModel({ provider: 'anthropic', model, toolUsage: 1 }))).toBe(false)
    expect(
      supportsPiCompaction(createMockModel({ provider: 'thunderbolt', vendor: 'anthropic', model, toolUsage: 1 })),
    ).toBe(false)
  })

  it('uses the same managed catalog alias as model resolution', () => {
    expect(
      supportsPiCompaction(
        createMockModel({ provider: 'thunderbolt', vendor: 'anthropic', model: 'opus-5-5', toolUsage: 1 }),
      ),
    ).toBe(true)
  })

  it('rejects unconfigured OpenAI-wire providers and tool-disabled legacy models', () => {
    for (const provider of ['openai', 'openrouter'] as const) {
      expect(supportsPiCompaction(createMockModel({ provider, apiKey: null, toolUsage: 1 }))).toBe(false)
      expect(supportsPiCompaction(createMockModel({ provider, apiKey: 'test', toolUsage: 1 }))).toBe(true)
    }
    expect(supportsPiCompaction(createMockModel({ provider: 'custom', url: null, toolUsage: 1 }))).toBe(false)
    expect(
      supportsPiCompaction(
        createMockModel({ provider: 'custom', url: 'http://localhost:11434', apiKey: null, toolUsage: 1 }),
      ),
    ).toBe(false)
    expect(
      supportsPiCompaction(
        createMockModel({ provider: 'custom', url: 'http://localhost:11434', apiKey: 'local', toolUsage: 1 }),
      ),
    ).toBe(true)
    expect(supportsPiCompaction(createMockModel({ provider: 'anthropic', toolUsage: 0 }))).toBe(false)
  })
})
