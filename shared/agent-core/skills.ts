/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Skill data needed by progressive disclosure, independent of its data source. */
export type SkillDefinition = {
  readonly name: string
  readonly description: string
  readonly instruction: string
}

/** ACP extension namespace owned by Thunderbolt. */
export const thunderboltAcpMetaKey = 'thunderbird.net/thunderbolt'

/** ACP agent-capability metadata advertising wire-delivered skills support. */
export const skillsCapabilityMeta = {
  [thunderboltAcpMetaKey]: { skills: true },
} as const

type AcpMeta = Readonly<Record<string, unknown>> | null | undefined

/** Narrow unknown ACP metadata values to plain records. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validate one complete skill definition received through ACP metadata. */
const isSkillDefinition = (value: unknown): value is SkillDefinition =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.description === 'string' &&
  typeof value.instruction === 'string'

/**
 * Detect Thunderbolt's custom ACP skills capability.
 *
 * @param meta - agent capability metadata from initialize response
 * @returns whether agent accepts skills on session lifecycle requests
 */
export const supportsWireSkills = (meta: AcpMeta): boolean => {
  const thunderbolt = meta?.[thunderboltAcpMetaKey]
  return isRecord(thunderbolt) && thunderbolt.skills === true
}

/**
 * Build ACP session metadata containing full skill definitions.
 *
 * @param skills - enabled skills disclosed to agent
 * @returns namespaced ACP metadata payload
 */
export const buildWireSkillsMeta = (skills: readonly SkillDefinition[]): Record<string, unknown> => ({
  [thunderboltAcpMetaKey]: { skills },
})

/**
 * Read valid skill definitions from Thunderbolt ACP session metadata.
 *
 * @param meta - metadata received on session/new or session/resume
 * @returns wire-delivered skills, excluding malformed entries
 */
export const readWireSkills = (meta: AcpMeta): SkillDefinition[] => {
  const thunderbolt = meta?.[thunderboltAcpMetaKey]
  if (!isRecord(thunderbolt) || !Array.isArray(thunderbolt.skills)) {
    return []
  }
  return thunderbolt.skills.filter(isSkillDefinition)
}

/**
 * Build compact skill catalog entries without tool-specific guidance.
 *
 * @param skills - enabled skills available to current agent
 * @returns one name and description per line, or undefined when empty
 */
export const buildSkillCatalog = (skills: readonly SkillDefinition[]): string | undefined => {
  if (skills.length === 0) {
    return undefined
  }
  return skills.map(({ name, description }) => `- ${name}: ${description.replace(/\s+/g, ' ').trim()}`).join('\n')
}

/**
 * Build compact system-prompt guidance for available skills.
 *
 * @param skills - enabled skills available to the current agent
 * @returns prompt section containing names and descriptions, or undefined when empty
 */
export const buildSkillListing = (skills: readonly SkillDefinition[]): string | undefined => {
  const catalog = buildSkillCatalog(skills)
  if (!catalog) {
    return undefined
  }
  return `## Skills
Use the \`skill\` tool to load full instructions before using a relevant skill. A \`/name\` token means its instructions are already loaded.
${catalog}`
}

/**
 * Resolve a skill by bare name or slash-prefixed slug.
 *
 * @param skills - enabled skills available to the current agent
 * @param requestedName - name supplied to the skill tool or slash resolver
 * @returns matching skill, or null when unavailable
 */
export const resolveSkill = (skills: readonly SkillDefinition[], requestedName: string): SkillDefinition | null => {
  const name = requestedName.trim().replace(/^\//, '')
  return skills.find((skill) => skill.name === name) ?? null
}
