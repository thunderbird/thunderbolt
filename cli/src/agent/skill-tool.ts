/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveSkill, type SkillDefinition } from '../../../shared/agent-core/skills.ts'

const skillSchema = Type.Object({
  name: Type.String({ description: 'Skill name or slash-prefixed slug from the system prompt skill list' }),
})

/**
 * Create Pi tool that resolves full instructions from wire-delivered skills.
 *
 * @param skills - skill definitions received during ACP session setup
 * @returns read-only skill lookup tool
 */
export const createSkillTool = (skills: readonly SkillDefinition[]): AgentTool<typeof skillSchema, string> => ({
  name: 'skill',
  label: 'skill',
  description: 'Load full instructions for an available skill using its exact name.',
  parameters: skillSchema,
  execute: async (_toolCallId, { name }) => {
    const skill = resolveSkill(skills, name)
    if (!skill) {
      throw new Error(`Skill "${name}" was not found or is disabled.`)
    }
    return {
      content: [{ type: 'text', text: skill.instruction }],
      details: skill.instruction,
    }
  },
})
