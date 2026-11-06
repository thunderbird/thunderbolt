/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { defaultModels } from '../agent/defaults.ts'
import type { ProviderManagerIO, ProviderManagerItem } from '../provider-runtime/types.ts'
import { collectByokProfile, collectByokRepair } from './wizard.ts'

describe('provider-manager BYOK prompts', () => {
  const managerIO = (options: {
    readonly choices?: readonly string[]
    readonly texts?: readonly (string | null)[]
    readonly secrets?: readonly (string | null)[]
  }) => {
    const choices = [...(options.choices ?? [])]
    const texts = [...(options.texts ?? [])]
    const secrets = [...(options.secrets ?? [])]
    const menus: { title: string; items: readonly ProviderManagerItem[] }[] = []
    const output: string[] = []
    const io: ProviderManagerIO = {
      choose: async (title, items) => {
        menus.push({ title, items })
        return choices.shift() ?? null
      },
      readText: async () => texts.shift() ?? null,
      readSecret: async () => secrets.shift() ?? null,
      write: (text) => output.push(text),
      showVerification: () => {},
      showStatus: () => {},
    }
    return { io, menus, output }
  }

  test('offers default, live, then remaining catalog models for an authenticated provider', async () => {
    const liveIds = [defaultModels.anthropic, 'claude-live']
    const catalogIds = builtinModels()
      .getModels('anthropic')
      .map(({ id }) => id)
    if (!catalogIds.some((id) => !liveIds.includes(id))) {
      throw new Error('Anthropic catalog fixture requires a catalog-only model')
    }
    const expectedIds = [...new Set([defaultModels.anthropic, ...liveIds, ...catalogIds])]
    const { io, menus, output } = managerIO({
      choices: ['builtin:anthropic', 'claude-live'],
      texts: ['Work Anthropic'],
      secrets: ['new-secret'],
    })

    const result = await collectByokProfile(io, {
      list: async () => ({ source: 'live', ids: liveIds, authenticated: true }),
    })

    expect(result).toMatchObject({
      profile: {
        id: expect.stringMatching(/^byok-/),
        label: 'Work Anthropic',
        provider: 'anthropic',
        defaultModel: 'claude-live',
        apiKey: 'new-secret',
        credentialStatus: 'authenticated',
      },
      apiKey: 'new-secret',
    })
    expect(menus[0]?.items.some(({ id }) => id === 'builtin:anthropic')).toBe(true)
    expect(menus[1]?.items.map(({ id }) => id)).toEqual(expectedIds)
    expect(output.join('')).not.toContain('new-secret')
  })

  test('keeps a new compatible key scoped to the exact entered endpoint', async () => {
    const { io } = managerIO({
      choices: ['compat:custom', 'custom-model'],
      texts: ['Custom', 'https://models.example/v1'],
      secrets: ['compat-secret'],
    })

    const result = await collectByokProfile(io, {
      list: async (options) => {
        expect(options).toMatchObject({
          provider: 'openai-compat',
          apiKey: 'compat-secret',
          baseUrl: 'https://models.example/v1',
        })
        return { source: 'live', ids: ['custom-model'], authenticated: true }
      },
    })

    expect(result?.profile).toMatchObject({
      provider: 'openai-compat',
      baseUrl: 'https://models.example/v1',
      apiKey: 'compat-secret',
    })
  })

  test('collects an authentication-required profile after a second explicit key rejection', async () => {
    const { io, output } = managerIO({
      choices: ['builtin:openai', 'gpt-test'],
      texts: ['Rejected OpenAI'],
      secrets: ['bad-key', 'still-bad'],
    })

    const result = await collectByokProfile(io, {
      list: async () => ({
        source: 'catalog',
        ids: ['gpt-test'],
        authenticated: false,
        wasAuthRejected: true,
        status: 401,
      }),
    })

    expect(result?.profile).toMatchObject({
      apiKey: 'still-bad',
      credentialStatus: 'authentication-required',
    })
    expect(output.join('')).toContain('authentication required')
  })

  test('collects a not-authenticated offline candidate when authentication is unvalidated', async () => {
    const { io, output } = managerIO({
      choices: ['builtin:openai', 'gpt-catalog'],
      texts: ['Unverified OpenAI'],
      secrets: ['unverified-key'],
    })

    const result = await collectByokProfile(io, {
      list: async () => ({ source: 'catalog', ids: ['gpt-catalog'], authenticated: false }),
    })

    expect(result?.profile).toMatchObject({
      apiKey: 'unverified-key',
      defaultModel: 'gpt-catalog',
      credentialStatus: 'not-authenticated',
    })
    expect(output.join('')).toContain('not authenticated')
  })

  test('repairs a built-in snapshot row without exposing or reusing the old key', async () => {
    const { io, output } = managerIO({ secrets: ['replacement-key'] })

    const result = await collectByokRepair(
      io,
      {
        id: 'byok-work',
        label: 'Work OpenAI',
        provider: 'openai',
        status: 'authentication required',
        defaultModel: 'gpt-old',
      },
      { list: async () => ({ source: 'live', ids: ['gpt-old'], authenticated: true }) },
    )

    expect(result).toEqual({
      profile: {
        id: 'byok-work',
        label: 'Work OpenAI',
        provider: 'openai',
        defaultModel: 'gpt-old',
        apiKey: 'replacement-key',
        credentialStatus: 'authenticated',
      },
      apiKey: 'replacement-key',
    })
    expect(output.join('')).not.toContain('replacement-key')
  })

  test('collects a not-authenticated repair when the listing cannot validate', async () => {
    const { io, output } = managerIO({ secrets: ['replacement-key'] })

    const result = await collectByokRepair(
      io,
      {
        id: 'byok-work',
        label: 'Work OpenAI',
        provider: 'openai',
        status: 'authentication required',
        defaultModel: 'gpt-old',
      },
      { list: async () => ({ source: 'catalog', ids: ['gpt-old'], authenticated: false }) },
    )

    expect(result?.profile).toMatchObject({
      apiKey: 'replacement-key',
      credentialStatus: 'not-authenticated',
    })
    expect(output.join('')).toContain('not authenticated')
  })

  test('persists an explicit API format for an unknown Fireworks model', async () => {
    const { io, menus } = managerIO({
      choices: ['builtin:fireworks', 'fireworks:custom', 'openai-completions'],
      texts: ['Future Fireworks', 'future-fireworks-model'],
      secrets: ['fireworks-key'],
    })

    const result = await collectByokProfile(io, {
      list: async () => ({ source: 'catalog', ids: ['known-fireworks-model'], authenticated: false }),
    })

    expect(result?.profile).toMatchObject({
      id: expect.stringMatching(/^byok-/),
      label: 'Future Fireworks',
      provider: 'fireworks',
      defaultModel: 'future-fireworks-model',
      apiKey: 'fireworks-key',
      credentialStatus: 'not-authenticated',
      modelApi: 'openai-completions',
    })
    expect(menus.some(({ title }) => title === 'Fireworks API format')).toBe(true)
  })

  test('derives a known Fireworks model protocol without asking the user to guess', async () => {
    const known = builtinModels().getModels('fireworks')[0]
    if (!known || (known.api !== 'anthropic-messages' && known.api !== 'openai-completions')) {
      throw new Error('Fireworks catalog fixture requires a supported protocol')
    }
    const { io, menus } = managerIO({
      choices: ['builtin:fireworks', known.id],
      texts: ['Known Fireworks'],
      secrets: ['fireworks-key'],
    })

    const result = await collectByokProfile(io, {
      list: async () => ({ source: 'catalog', ids: [known.id], authenticated: false }),
    })

    expect(result?.profile).toMatchObject({
      provider: 'fireworks',
      defaultModel: known.id,
      modelApi: known.api,
    })
    expect(menus.some(({ title }) => title === 'Fireworks API format')).toBe(false)
  })
})
