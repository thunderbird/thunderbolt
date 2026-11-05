/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import type { SkillDefinition } from '../../../shared/agent-core/skills.ts'
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { noopBindingLifecycle, type PreparedPiBinding } from '../provider-runtime/types.ts'
import { createHarnessRuntime, createHarnessTools } from './harness.ts'

describe('createHarnessTools', () => {
  test('registers webfetch for local REPL and ACP workspace harnesses', () => {
    expect(createHarnessTools({ cwd: '/work' }).map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'webfetch',
    ])
    expect(createHarnessTools({ cwd: '/work', workspaceRoot: '/work' }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'webfetch',
    ])
  })

  test('registers skill tool only when session provides skills', () => {
    const skills: SkillDefinition[] = [
      { name: 'daily-brief', description: 'Build a daily rundown.', instruction: 'Gather current details.' },
    ]

    expect(createHarnessTools({ cwd: '/work' }).map((tool) => tool.name)).not.toContain('skill')
    expect(createHarnessTools({ cwd: '/work', skills }).map((tool) => tool.name)).toContain('skill')
  })
})

describe('createHarnessRuntime saved effort', () => {
  test.each([
    ['high', 'high'],
    ['off', 'none'],
    ['minimal', 'low'],
    ['unsupported-legacy-level', 'high'],
  ] as const)('restores saved %s as effective %s before initialization', async (saved, expected) => {
    const session = await new InMemorySessionRepo().create({})
    await session.appendThinkingLevelChange('medium')
    await session.appendThinkingLevelChange(saved)
    const faux = fauxProvider({ models: [{ id: 'saved-effort', reasoning: true }] })
    const binding: PreparedPiBinding = {
      ...noopBindingLifecycle,
      providerId: faux.provider.id,
      wireModel: 'saved-effort',
      persistsCredentialStatus: false,
      piModel: { ...faux.getModel(), thinkingLevelMap: { off: 'none', minimal: 'low' } },
      install: (models) => models.setProvider(faux.provider),
    }
    const runtime = await createHarnessRuntime({ cwd: process.cwd(), thinking: 'high' }, binding, session)
    try {
      expect(runtime.reasoning.current()).toBe(expected)
      expect(
        (await session.getBranch())
          .filter((entry) => entry.type === 'thinking_level_change')
          .map((entry) => entry.thinkingLevel),
      ).toContain(saved)
    } finally {
      await runtime.dispose()
    }
  })
})
