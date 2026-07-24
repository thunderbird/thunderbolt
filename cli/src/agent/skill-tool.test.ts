/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { buildWireSkillsMeta, readWireSkills, type SkillDefinition } from '../../../shared/agent-core/skills.ts'
import { createSkillTool } from './skill-tool.ts'
import { buildSystemPrompt } from './system-prompt.ts'

const skills: SkillDefinition[] = [
  {
    name: 'daily-brief',
    description: 'Build a concise daily rundown.',
    instruction: 'Gather current weather and calendar details.',
  },
]

describe('wire-delivered CLI skills', () => {
  test('lists compact metadata and resolves full instructions through tool', async () => {
    const wireSkills = readWireSkills(buildWireSkillsMeta(skills))
    const prompt = buildSystemPrompt({ cwd: '/work', skills: wireSkills })
    const result = await createSkillTool(wireSkills).execute('call-1', { name: '/daily-brief' })

    expect(prompt).toContain('- daily-brief: Build a concise daily rundown.')
    expect(prompt).not.toContain('Gather current weather')
    expect(result.content).toEqual([{ type: 'text', text: skills[0].instruction }])
  })

  test('rejects unavailable skill names', async () => {
    await expect(createSkillTool(skills).execute('call-1', { name: 'unknown' })).rejects.toThrow(
      'Skill "unknown" was not found or is disabled.',
    )
  })
})
