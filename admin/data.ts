/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { Model } from '@/types'
import type { SkillFormValues } from '@/skills/skill-form'
import { originalAgentFixtures, type OriginalAgentFixture } from './original-agent-fixtures'

export type AccessMode = 'everyone' | 'admins' | 'restricted'
export type PreviewAgent = OriginalAgentFixture & {
  enabled: boolean
  accessMode: AccessMode
  groupIds: string[]
  memberIds: string[]
  deletedAt: number | null
}

export type CompanySkill = SkillFormValues & { id: string; enabled: boolean; deletedAt: number | null }
export type CompanyMcpServer = {
  id: string
  name: string
  url: string
  transport: 'http' | 'sse'
  enabled: number
  deletedAt: number | null
}
export type CompanyModel = Pick<Model, 'id' | 'name' | 'model' | 'provider' | 'url' | 'enabled'> & {
  deletedAt: number | null
}
export type AgentPolicy = {
  personalAgentsAllowed: boolean
  thunderboltAllowed: boolean
  personalModelsAllowed: boolean
}

export type PreviewMember = {
  id: string
  name: string
  email: string
  role: 'admin' | 'member'
  status: 'active' | 'invited'
  groupIds: string[]
  deletedAt: number | null
}

export type PreviewGroup = { id: string; name: string; deletedAt: number | null }
export type PreviewState = {
  agents: PreviewAgent[]
  members: PreviewMember[]
  groups: PreviewGroup[]
  companySkills: CompanySkill[]
  companyMcpServers: CompanyMcpServer[]
  companyModels: CompanyModel[]
  policy: AgentPolicy
}

/** Sample content adapted from the credited workspaces proposal, never real account data. */
export const createPreviewState = (): PreviewState => ({
  groups: ['Engineering', 'Sales', 'Finance', 'Support', 'Marketing'].map((name) => ({
    id: name.toLowerCase(),
    name,
    deletedAt: null,
  })),
  agents: originalAgentFixtures.map((agent) => ({
    ...agent,
    enabled: true,
    accessMode: agent.grantedVia === 'Everyone' ? 'everyone' : 'restricted',
    groupIds: agent.grantedVia === 'Everyone' ? [] : [agent.grantedVia.split(' ')[0].toLowerCase()],
    memberIds: [],
    deletedAt: null,
  })),
  members: [
    {
      id: 'avery',
      name: 'Avery Morgan',
      email: 'avery@example.com',
      role: 'admin',
      status: 'active',
      groupIds: ['engineering'],
    },
    {
      id: 'jamie',
      name: 'Jamie Chen',
      email: 'jamie@example.com',
      role: 'member',
      status: 'active',
      groupIds: ['sales'],
    },
    {
      id: 'sam',
      name: 'Sam Rivera',
      email: 'sam@example.com',
      role: 'member',
      status: 'active',
      groupIds: ['finance'],
    },
    {
      id: 'alex',
      name: 'Alex Kim',
      email: 'alex@example.com',
      role: 'member',
      status: 'active',
      groupIds: ['support', 'marketing'],
    },
    {
      id: 'taylor',
      name: 'Taylor Quinn',
      email: 'taylor@example.com',
      role: 'member',
      status: 'invited',
      groupIds: ['engineering'],
    },
  ].map((member) => ({
    ...member,
    role: member.role as PreviewMember['role'],
    status: member.status as PreviewMember['status'],
    deletedAt: null,
  })),
  companySkills: [
    {
      id: 'brand-voice',
      name: 'brand-voice',
      label: 'Brand voice',
      instruction: '',
      enabled: true,
      description: 'Company tone-of-voice guide agents apply when drafting copy.',
      deletedAt: null,
    },
    {
      id: 'expense-policy',
      name: 'expense-policy',
      label: 'Expense policy',
      instruction: '',
      enabled: true,
      description: 'Rules for approving and categorizing expenses.',
      deletedAt: null,
    },
  ],
  companyMcpServers: [],
  companyModels: [],
  policy: { personalAgentsAllowed: true, thunderboltAllowed: true, personalModelsAllowed: true },
})

/** New endpoints start without advertised capabilities or access grants. */
export const createCompanyAgent = (): PreviewAgent => ({
  id: crypto.randomUUID(),
  name: '',
  description: '',
  acpUrl: '',
  category: 'sealed',
  icon: 'bot',
  managedBy: 'Your organization',
  grantedVia: '',
  advertisedModels: [],
  integrations: [],
  mcpKinds: [],
  toolKinds: [],
  accepts: [],
  modes: [],
  agentSkillCount: 0,
  capabilities: [],
  enabled: true,
  accessMode: 'restricted',
  groupIds: [],
  memberIds: [],
  deletedAt: null,
})
