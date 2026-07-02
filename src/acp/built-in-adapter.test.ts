/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `harnessSignature` tests — the fingerprint that drives the per-thread harness
 * cache. A stable signature for unchanged config keeps the live harness; any
 * change to model / provider / key / base url / reasoning / thinking level /
 * system prompt must produce a different signature so a mid-thread config switch
 * rebuilds the harness instead of silently reusing the first turn's config.
 */

import '@/testing-library'

import { describe, expect, it } from 'bun:test'
import { harnessSignature, type ResolvedPiModel } from './built-in-adapter'
import type { PiModelDescriptor } from '@shared/agent-core'

const noopFetch = (async () => new Response('')) as PiModelDescriptor['fetch']

const anthropic = (overrides: Partial<Extract<PiModelDescriptor, { kind: 'anthropic' }>> = {}): ResolvedPiModel => ({
  descriptor: { kind: 'anthropic', modelId: 'claude-opus-4-8', apiKey: 'sk-a', fetch: noopFetch, ...overrides },
  thinkingLevel: 'medium',
})

const openaiCompat = (
  overrides: Partial<Extract<PiModelDescriptor, { kind: 'openai-compat' }>> = {},
): ResolvedPiModel => ({
  descriptor: {
    kind: 'openai-compat',
    providerId: 'openai',
    modelId: 'gpt-5',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-o',
    fetch: noopFetch,
    reasoning: false,
    ...overrides,
  },
  thinkingLevel: 'medium',
})

const noMcp = ''

describe('harnessSignature', () => {
  it('is stable for identical config', () => {
    expect(harnessSignature(anthropic(), 'sys', noMcp)).toBe(harnessSignature(anthropic(), 'sys', noMcp))
  })

  it('changes when the model id changes', () => {
    expect(harnessSignature(anthropic(), 'sys', noMcp)).not.toBe(
      harnessSignature(anthropic({ modelId: 'claude-sonnet-4-8' }), 'sys', noMcp),
    )
  })

  it('changes when the api key changes', () => {
    expect(harnessSignature(anthropic(), 'sys', noMcp)).not.toBe(
      harnessSignature(anthropic({ apiKey: 'sk-b' }), 'sys', noMcp),
    )
  })

  it('changes when the system prompt changes', () => {
    expect(harnessSignature(anthropic(), 'sys', noMcp)).not.toBe(harnessSignature(anthropic(), 'other', noMcp))
  })

  it('changes when the thinking level changes', () => {
    const high: ResolvedPiModel = { ...anthropic(), thinkingLevel: 'high' }
    expect(harnessSignature(anthropic(), 'sys', noMcp)).not.toBe(harnessSignature(high, 'sys', noMcp))
  })

  it('changes when the set of MCP servers changes', () => {
    expect(harnessSignature(anthropic(), 'sys', noMcp)).not.toBe(
      harnessSignature(anthropic(), 'sys', 'srv-1@https://a'),
    )
  })

  it('does not collide across provider families', () => {
    expect(harnessSignature(anthropic(), 'sys', noMcp)).not.toBe(harnessSignature(openaiCompat(), 'sys', noMcp))
  })

  it('changes when the openai-compat base url changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys', noMcp)).not.toBe(
      harnessSignature(openaiCompat({ baseURL: 'https://other/v1' }), 'sys', noMcp),
    )
  })

  it('changes when the openai-compat reasoning flag changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys', noMcp)).not.toBe(
      harnessSignature(openaiCompat({ reasoning: true }), 'sys', noMcp),
    )
  })

  it('changes when the openai-compat context window changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys', noMcp)).not.toBe(
      harnessSignature(openaiCompat({ contextWindow: 200000 }), 'sys', noMcp),
    )
  })

  it('does not embed the plaintext api key', () => {
    expect(harnessSignature(anthropic({ apiKey: 'super-secret-key' }), 'sys', noMcp)).not.toContain('super-secret-key')
  })
})
