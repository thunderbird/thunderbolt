/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveSkill, type SkillDefinition } from '@shared/agent-core/skills'
import { selectMinimalMode, useConfigStore } from '@/api/config-store'
import { isWidgetSkillId, selectOfferedSkillRows, skillInstruction } from '@/defaults/skills'
import { tool, type Tool } from 'ai'
import { z } from 'zod'

/** A skill offered to one built-in request. Its id lets an Office skill's manual load only when the skill is used. */
export type RequestSkillDefinition = SkillDefinition & { readonly id: string }

type StoredSkillDefinition = RequestSkillDefinition & { readonly enabled: number }

/**
 * Select enabled skills and discard persistence-only fields.
 *
 * @param skills - skill rows from any app data source
 * @param offersOfficeSkills - true only for a built-in request with `run_office_script` and the `skill` tool; see
 *   `selectOfferedSkillRows`, which drops the Office skills otherwise
 * @returns enabled skill definitions suitable for prompt and tool injection;
 *   in minimal mode only the widget rendering contracts. Each keeps its id, so
 *   an Office skill's manual loads through `skillInstruction` only when the
 *   `skill` tool or a `/slug` asks for it; until then it carries its row's
 *   stub.
 *
 * Minimal mode withholds every user-invocable skill (the listing, the `skill`
 * tool and the ACP skills metadata are built from this list) but keeps the
 * widget skills: they are model-facing rendering contracts, not slash commands,
 * and without them weather, map and link-preview cards would stop rendering.
 * The ACP metadata keeps them for the same reason, so a remote agent can still
 * emit widgets the app renders. Reads the store imperatively, like
 * `resolveSkillTokenInstructions`, because the callers sit outside React.
 */
export const selectEnabledSkillDefinitions = (
  skills: readonly StoredSkillDefinition[],
  offersOfficeSkills = false,
): RequestSkillDefinition[] =>
  selectOfferedSkillRows(skills, offersOfficeSkills)
    .filter((skill) => skill.enabled === 1)
    .filter((skill) => !selectMinimalMode(useConfigStore.getState().config) || isWidgetSkillId(skill.id))
    .map(({ id, name, description, instruction }) => ({ id, name, description, instruction }))

/**
 * Create AI SDK tool that loads one enabled skill's full instructions.
 *
 * @param skills - enabled skills available for this request
 * @param onSkillLoaded - synchronous notification after resolving non-empty instructions
 * @param loaded - collects the name of each skill whose instructions the tool returned, once they did
 * @returns skill lookup tool shared by classic and Pi request paths
 */
export const createSkillTool = (
  skills: readonly RequestSkillDefinition[],
  onSkillLoaded?: (name: string) => void,
  loaded?: Set<string>,
): Tool<{ name: string }, string> =>
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
      // The row's own text decides, so the notification stays synchronous: an Office row's stub is never empty.
      if (skill.instruction.trim()) {
        onSkillLoaded?.(skill.name)
      }
      // An Office manual can fail to load, and then the model has not read it.
      const instruction = await skillInstruction(skill)
      loaded?.add(skill.name)
      return instruction
    },
  })
