/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import type { ToolCallOptions } from 'ai'
import { defaultSkillOfficeXlsx } from '@/defaults/skills'
import * as officeSkills from '@/office/skills'
import { officeXlsxSkill } from '@/office/skills/xlsx'
import { stubAppServer } from '@/test-utils/app-server'
import { loadSkillTokenInstructions, resolveSkillTokenInstructions } from './resolve-skill-system-messages'
import { createSkillTool, selectEnabledSkillDefinitions } from './skill-tool'

const toolCallOptions: ToolCallOptions = { toolCallId: 'skill-call', messages: [] }
const storedSkills = [
  {
    id: 'daily-brief',
    name: 'daily-brief',
    description: 'Use for a daily rundown.',
    instruction: 'Gather weather, news, email, and calendar details.',
    enabled: 1,
  },
  {
    id: 'disabled-skill',
    name: 'disabled-skill',
    description: 'Unavailable.',
    instruction: 'Never expose this instruction.',
    enabled: 0,
  },
]

describe('createSkillTool', () => {
  afterEach(() => mock.restore())

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

  it("serves an Office skill's bundled manual, even when another row has its name", async () => {
    const clash = { id: 'user-skill', name: 'office-xlsx', description: 'Mine', instruction: 'My notes', enabled: 1 }
    const skills = selectEnabledSkillDefinitions([clash, defaultSkillOfficeXlsx], true)
    const skillTool = createSkillTool(skills)
    stubAppServer()

    expect(skills.filter(({ name }) => name === 'office-xlsx')).toHaveLength(1)
    expect(await skillTool.execute!({ name: '/office-xlsx' }, toolCallOptions)).toBe(officeXlsxSkill)
    expect(await loadSkillTokenInstructions('/office-xlsx', skills)).toEqual([officeXlsxSkill])
    // A disabled Office row still owns its name.
    const disabled = selectEnabledSkillDefinitions([clash, { ...defaultSkillOfficeXlsx, enabled: 0 }], true)
    expect(disabled.map(({ name }) => name)).toEqual([])
  })

  it('records a skill as loaded only once its instructions are returned', async () => {
    const loaded = new Set<string>()
    const skillTool = createSkillTool(selectEnabledSkillDefinitions([defaultSkillOfficeXlsx], true), undefined, loaded)
    spyOn(officeSkills, 'loadOfficeSkillBody').mockRejectedValueOnce(new Error('offline'))

    await expect(skillTool.execute!({ name: 'office-xlsx' }, toolCallOptions)).rejects.toThrow('offline')
    expect([...loaded]).toEqual([])
    stubAppServer()
    expect(await skillTool.execute!({ name: '/office-xlsx' }, toolCallOptions)).toBe(officeXlsxSkill)
    expect([...loaded]).toEqual(['office-xlsx'])
  })

  it('offers no Office skill unless the caller opts in, and the user row keeps its name', async () => {
    const clash = { id: 'user-skill', name: 'office-xlsx', description: 'Mine', instruction: 'My notes', enabled: 1 }
    const skills = selectEnabledSkillDefinitions([clash, defaultSkillOfficeXlsx])

    expect(skills.map(({ id }) => id)).toEqual(['user-skill'])
    expect(await createSkillTool(skills).execute!({ name: '/office-xlsx' }, toolCallOptions)).toBe('My notes')
    expect(await loadSkillTokenInstructions('/office-xlsx', skills)).toEqual(['My notes'])
  })

  it('keeps /slug as a forced trigger without requiring a tool call', () => {
    const skills = selectEnabledSkillDefinitions(storedSkills)
    const instructionBySlug = new Map(skills.map(({ name, instruction }) => [name, instruction]))

    expect(resolveSkillTokenInstructions('Run /daily-brief now', instructionBySlug)).toEqual([
      'Gather weather, news, email, and calendar details.',
    ])
  })
})

it('notifies synchronously with the resolved name only after a successful load', async () => {
  const loaded: string[] = []
  const skills = selectEnabledSkillDefinitions([
    ...storedSkills,
    { id: 'research', name: 'research', description: 'Research', instruction: 'Research instructions', enabled: 1 },
  ])
  const skill = createSkillTool(skills, (name) => loaded.push(name))
  const first = skill.execute!({ name: 'daily-brief' }, toolCallOptions)
  expect(loaded).toEqual(['daily-brief'])
  await first
  await expect(skill.execute!({ name: 'missing' }, toolCallOptions)).rejects.toThrow('not found')
  expect(loaded).toEqual(['daily-brief'])
  const research = skill.execute!({ name: ' /research ' }, toolCallOptions)
  expect(loaded).toEqual(['daily-brief', 'research'])
  expect(await research).toBe('Research instructions')
})

it.each(['', '   '])('does not notify for disabled or empty instructions (%j)', async (instruction) => {
  for (const enabled of [0, 1]) {
    const loaded: string[] = []
    const skill = createSkillTool(
      selectEnabledSkillDefinitions([
        { id: 'research', name: 'research', description: 'Research', instruction, enabled },
      ]),
      (name) => loaded.push(name),
    )
    if (enabled) {
      expect(await skill.execute!({ name: 'research' }, toolCallOptions)).toBe(instruction)
    } else {
      await expect(skill.execute!({ name: 'research' }, toolCallOptions)).rejects.toThrow('disabled')
    }
    expect(loaded).toEqual([])
  }
})
