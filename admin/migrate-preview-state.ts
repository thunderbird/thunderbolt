/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { slugifySkillName } from '@/dal'
import { createCompanyAgent, createPreviewState, type PreviewAgent, type PreviewState } from './data'

type LegacyAgent = Pick<PreviewAgent, 'id' | 'name' | 'description' | 'enabled' | 'groupIds' | 'deletedAt'>
type LegacyState = Pick<PreviewState, 'members' | 'groups'> & { agents: LegacyAgent[] }

const legacyIds: Record<string, string> = {
  'demo-sales-agent': 'sales',
  'demo-finance-kb': 'finance',
  'demo-support-agent': 'support',
  'demo-marketing-agent': 'marketing',
  'demo-code-review': 'code-review',
}

/** Replace the invented resource catalog with the original design, retaining local member/group and agent edits. */
export const migratePreviewState = (previous: LegacyState): PreviewState => {
  const source = createPreviewState()
  const legacyBuiltIn = previous.agents.find((agent) => agent.id === 'thunderbolt')
  const reservedIds = new Set(['thunderbolt', 'onboarding', 'research', ...Object.values(legacyIds)])
  return {
    ...source,
    members: previous.members,
    groups: previous.groups,
    policy: { ...source.policy, thunderboltAllowed: legacyBuiltIn?.enabled !== false },
    agents: [
      ...source.agents.map((agent) => {
        const legacy = previous.agents.find((item) => item.id === legacyIds[agent.id])
        if (!legacy) {
          return agent
        }
        return {
          ...agent,
          ...legacy,
          id: agent.id,
          accessMode: legacy.groupIds.length ? ('restricted' as const) : ('everyone' as const),
        }
      }),
      ...previous.agents
        .filter((agent) => !reservedIds.has(agent.id))
        .map((agent) => ({
          ...createCompanyAgent(),
          ...agent,
          accessMode: agent.groupIds.length ? ('restricted' as const) : ('everyone' as const),
        })),
    ],
  }
}

export type MetadataPreviewState = Omit<PreviewState, 'companySkills' | 'companyMcpServers' | 'companyModels'> & {
  companySkills: { id: string; name: string; description: string; deletedAt: number | null }[]
}

/** Preserve existing metadata and soft deletions while opening up full skill editing. */
export const migrateResourcePages = (previous: MetadataPreviewState): PreviewState => ({
  ...previous,
  companySkills: previous.companySkills.map((skill, index) => ({
    ...skill,
    label: skill.name,
    // Metadata names were not unique. A stable suffix keeps every legacy skill editable.
    name: `${slugifySkillName(skill.name).slice(0, 48).replace(/-+$/, '') || 'skill'}-${index + 1}`,
    instruction: '',
    enabled: true,
  })),
  companyMcpServers: [],
  companyModels: [],
})
