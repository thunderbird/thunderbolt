/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveSkill, type SkillDefinition } from '@shared/agent-core/skills'
import { tool, type Tool } from 'ai'
import { z } from 'zod'

type StoredSkillDefinition = SkillDefinition & {
  readonly enabled: number
}

/**
 * Select enabled skills and discard persistence-only fields.
 *
 * @param skills - skill rows from any app data source
 * @returns enabled skill definitions suitable for prompt and tool injection
 */
export const selectEnabledSkillDefinitions = (skills: readonly StoredSkillDefinition[]): SkillDefinition[] =>
  skills
    .filter((skill) => skill.enabled === 1)
    .map(({ name, description, instruction }) => ({ name, description, instruction }))

/**
 * Create AI SDK tool that loads one enabled skill's full instructions.
 *
 * @param skills - enabled skills available for this request
 * @returns skill lookup tool shared by classic and Pi request paths
 */
export const createSkillTool = (skills: readonly SkillDefinition[]): Tool<{ name: string }, string> =>
  tool({
    description:
      'Load full instructions for an enabled skill. Use the exact skill name from the system prompt skill list.',
    inputSchema: z.object({
      name: z.string().describe('Skill name or slash-prefixed slug from the system prompt skill list'),
    }),
    execute: async ({ name }) => {
      const skill = resolveSkill(skills, name)
      if (!skill) {
        throw new Error(`Skill "${name}" was not found or is disabled.`)
      }
      return skill.instruction
    },
  })
