/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { MockLanguageModelV3 } from 'ai/test'
import { agentSetupSchema, generateAgentSetup, suggestedResourceSelections } from './agent-setup-suggestion'

const output = {
  name: 'Code reviewer',
  systemPrompt: 'Review changes carefully.',
  environment: 'sandbox' as const,
  models: ['Unknown model'],
  connections: ['GitHub', 'Not installed'],
  skills: [],
}
const modelWithOutput = (value: unknown) =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    },
  })

describe('agent setup generation', () => {
  it('uses structured output and sends only agent metadata, even if extra catalog data is supplied', async () => {
    const model = modelWithOutput(output)
    const input = {
      description: 'Review pull requests and catch bugs',
      desktopAvailable: false,
      resources: ['Private org resource'],
    }
    expect(await generateAgentSetup(model, input, new AbortController().signal, 'en')).toEqual(output)
    const call = model.doGenerateCalls[0]
    expect(call.responseFormat?.type).toBe('json')
    expect(JSON.stringify(call.prompt)).not.toContain('Private org resource')
    expect(JSON.stringify(call.prompt)).toContain('Review pull requests and catch bugs')
  })

  it('rejects malformed output and unavailable environment values', async () => {
    expect(agentSetupSchema.safeParse({ ...output, environment: 'cloud' }).success).toBe(false)
    expect(agentSetupSchema.safeParse({ ...output, name: '   ' }).success).toBe(false)
    await expect(
      generateAgentSetup(
        modelWithOutput({ name: 'Incomplete' }),
        {
          description: 'Review code',
          desktopAvailable: false,
        },
        new AbortController().signal,
        'en',
      ),
    ).rejects.toThrow()
  })

  it('only selects matching local resources and keeps a default model for unknown suggestions', () => {
    const selected = suggestedResourceSelections(output, [
      {
        id: 'model',
        kind: 'model',
        scope: 'personal',
        name: 'Configured model',
        description: '',
        defaultSelected: true,
      },
      { id: 'github', kind: 'mcp', scope: 'personal', name: 'GitHub', description: 'Code and issues' },
      { id: 'unrelated', kind: 'skill', scope: 'organization', name: 'Writing', description: 'Brand voice' },
    ])
    expect(selected).toEqual({ model: true, github: true, unrelated: false })
  })
})
