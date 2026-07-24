/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import type { ToolCallOptions } from 'ai'
import { resolveSkillTokenInstructions } from './resolve-skill-system-messages'
import { createSkillTool, selectEnabledSkillDefinitions } from './skill-tool'

const toolCallOptions: ToolCallOptions = { toolCallId: 'skill-call', messages: [] }
const storedSkills = [
  {
    name: 'daily-brief',
    description: 'Use for a daily rundown.',
    instruction: 'Gather weather, news, email, and calendar details.',
    enabled: 1,
  },
  {
    name: 'disabled-skill',
    description: 'Unavailable.',
    instruction: 'Never expose this instruction.',
    enabled: 0,
  },
]

describe('createSkillTool', () => {
  it('returns full instructions for an enabled skill name or slug', async () => {
    const skillTool = createSkillTool(selectEnabledSkillDefinitions(storedSkills))

    expect(await skillTool.execute!({ name: 'daily-brief' }, toolCallOptions)).toBe(
      'Gather weather, news, email, and calendar details.',
    )
    expect(await skillTool.execute!({ name: '/daily-brief' }, toolCallOptions)).toBe(
      'Gather weather, news, email, and calendar details.',
    )
  })

  it('rejects an unknown skill', async () => {
    const skillTool = createSkillTool(selectEnabledSkillDefinitions(storedSkills))

    await expect(skillTool.execute!({ name: 'unknown' }, toolCallOptions)).rejects.toThrow(
      'Skill "unknown" was not found or is disabled.',
    )
  })

  it('does not resolve a disabled skill', async () => {
    const skillTool = createSkillTool(selectEnabledSkillDefinitions(storedSkills))

    await expect(skillTool.execute!({ name: 'disabled-skill' }, toolCallOptions)).rejects.toThrow(
      'Skill "disabled-skill" was not found or is disabled.',
    )
  })

  it('returns the same full instruction through the Pi tool bridge', async () => {
    const skillTool = createSkillTool(selectEnabledSkillDefinitions(storedSkills))
    const [piSkillTool] = await toPiAgentTools({ skill: skillTool })

    expect(await piSkillTool.execute('skill-call', { name: 'daily-brief' })).toEqual({
      content: [{ type: 'text', text: 'Gather weather, news, email, and calendar details.' }],
      details: 'Gather weather, news, email, and calendar details.',
    })
  })

  it('keeps /slug as a forced trigger without requiring a tool call', () => {
    const skills = selectEnabledSkillDefinitions(storedSkills)
    const instructionBySlug = new Map(skills.map(({ name, instruction }) => [name, instruction]))

    expect(resolveSkillTokenInstructions('Run /daily-brief now', instructionBySlug)).toEqual([
      'Gather weather, news, email, and calendar details.',
    ])
  })
})
