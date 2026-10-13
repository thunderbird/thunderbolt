/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { create } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import {
  createPreviewState,
  type PreviewAgent,
  type PreviewGroup,
  type PreviewMember,
  type PreviewState,
  type CompanySkill,
  type CompanyMcpServer,
  type CompanyModel,
  type AgentPolicy,
} from './data'
import { migratePreviewState, migrateResourcePages } from './migrate-preview-state'

export type PreviewAction =
  | { type: 'save-agent'; agent: PreviewAgent }
  | { type: 'save-member'; member: PreviewMember }
  | { type: 'save-group'; group: PreviewGroup }
  | {
      type: 'remove'
      kind: 'agents' | 'members' | 'groups' | 'companySkills' | 'companyMcpServers' | 'companyModels'
      id: string
      at: number
    }
  | { type: 'membership'; memberId: string; groupId: string; enabled: boolean }
  | { type: 'policy'; patch: Partial<AgentPolicy> }
  | { type: 'save-skill'; skill: CompanySkill }
  | { type: 'save-mcp-server'; server: CompanyMcpServer }
  | { type: 'save-model'; model: CompanyModel }
  | {
      type: 'agent-access'
      id: string
      accessMode: PreviewAgent['accessMode']
      groupIds: string[]
      memberIds: string[]
    }
  | { type: 'reset' }

/** Replace a sample entity in place or append a newly created one. */
const upsert = <T extends { id: string }>(items: T[], item: T): T[] =>
  items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item]

/** One immutable, in-memory model for every admin screen; no IO or app database writes. */
export const previewReducer = (state: PreviewState, action: PreviewAction): PreviewState => {
  switch (action.type) {
    case 'save-agent':
      return { ...state, agents: upsert(state.agents, action.agent) }
    case 'save-member':
      return { ...state, members: upsert(state.members, action.member) }
    case 'save-group':
      return { ...state, groups: upsert(state.groups, action.group) }
    case 'remove':
      return {
        ...state,
        [action.kind]: state[action.kind].map((item) =>
          item.id === action.id ? { ...item, deletedAt: action.at } : item,
        ),
      }
    case 'membership':
      return {
        ...state,
        members: state.members.map((member) =>
          member.id !== action.memberId
            ? member
            : {
                ...member,
                groupIds: action.enabled
                  ? [...new Set([...member.groupIds, action.groupId])]
                  : member.groupIds.filter((id) => id !== action.groupId),
              },
        ),
      }
    case 'policy':
      return { ...state, policy: { ...state.policy, ...action.patch } }
    case 'save-skill':
      return { ...state, companySkills: upsert(state.companySkills, action.skill) }
    case 'save-mcp-server':
      return { ...state, companyMcpServers: upsert(state.companyMcpServers, action.server) }
    case 'save-model':
      return { ...state, companyModels: upsert(state.companyModels, action.model) }
    case 'agent-access':
      return {
        ...state,
        agents: state.agents.map((agent) =>
          agent.id !== action.id
            ? agent
            : {
                ...agent,
                accessMode: action.accessMode,
                groupIds: action.accessMode === 'restricted' ? [...new Set(action.groupIds)] : [],
                memberIds: action.accessMode === 'restricted' ? [...new Set(action.memberIds)] : [],
              },
        ),
      }
    case 'reset':
      return createPreviewState()
  }
}

type AdminStore = { state: PreviewState; dispatch: (action: PreviewAction) => void }

/** Persist only the local design data, independently of the application's database. */
const persistedAdminState = (getStorage: () => StateStorage) =>
  persist<AdminStore, [], [], Pick<AdminStore, 'state'>>(
    (set) => ({
      state: createPreviewState(),
      dispatch: (action) => set((store) => ({ state: previewReducer(store.state, action) })),
    }),
    {
      name: 'thunderbolt-admin-design',
      version: 4,
      migrate: (persisted, version) => {
        if (version === 1) {
          const previous = persisted as { state: Parameters<typeof migratePreviewState>[0] }
          return { state: migratePreviewState(previous.state) }
        }
        if (version === 2) {
          const previous = persisted as { state: Parameters<typeof migrateResourcePages>[0] }
          return { state: migrateResourcePages(previous.state) }
        }
        if (version === 3) {
          const previous = persisted as { state: Omit<PreviewState, 'companyModels'> }
          return { state: { ...previous.state, companyModels: [] } }
        }
        throw new Error('Unsupported admin proposal data version')
      },
      storage: createJSONStorage(getStorage),
      partialize: ({ state }) => ({ state }),
    },
  )

/** Construct the same persistent state outside React for storage-boundary tests. */
export const createAdminStore = (storage: StateStorage) => createStore(persistedAdminState(() => storage))

const useAdminStore = create(persistedAdminState(() => localStorage))

/** Local edits survive route changes and reloads until the sample data is reset. */
export const useAdminPreviewState = () => {
  const { state, dispatch } = useAdminStore()
  return {
    state,
    dispatch,
    agents: state.agents.filter((item) => item.deletedAt === null),
    members: state.members.filter((item) => item.deletedAt === null),
    groups: state.groups.filter((item) => item.deletedAt === null),
    companySkills: state.companySkills.filter((item) => item.deletedAt === null),
    companyMcpServers: state.companyMcpServers.filter((item) => item.deletedAt === null),
    companyModels: state.companyModels.filter((item) => item.deletedAt === null),
  }
}

export type AdminPreview = ReturnType<typeof useAdminPreviewState>
