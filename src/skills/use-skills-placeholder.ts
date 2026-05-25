/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { baseSkills, type Skill } from './skills-data'

const recentLimit = 20

const initialPinned = (): Set<string> => new Set(baseSkills.filter((s) => s.pinned).map((s) => s.name))

const buildLibrary = (localOverrides: Map<string, Skill>, deleted: Set<string>): Skill[] => {
  const merged = new Map<string, Skill>()
  for (const skill of baseSkills) {
    merged.set(skill.name, skill)
  }
  for (const [name, override] of localOverrides) {
    merged.set(name, override)
  }
  for (const name of deleted) {
    merged.delete(name)
  }
  return [...merged.values()]
}

type SkillsState = {
  pinnedOrder: string[]
  pinnedSet: Set<string>
  disabled: Set<string>
  recent: string[]
  localOverrides: Map<string, Skill>
  deleted: Set<string>

  togglePin: (name: string) => void
  movePinned: (name: string, index: number) => void
  setEnabled: (name: string, next: boolean) => void
  recordUsed: (name: string) => void
  addLocalSkill: (skill: { name: string; description: string; instruction: string }) => void
  updateLocalSkill: (previousName: string, next: { name: string; description: string; instruction: string }) => void
  markDeleted: (name: string) => void
}

export const useSkillsStore = create<SkillsState>()((set) => ({
  pinnedOrder: baseSkills.filter((s) => s.pinned).map((s) => s.name),
  pinnedSet: initialPinned(),
  disabled: new Set(),
  recent: [],
  localOverrides: new Map(),
  deleted: new Set(),

  togglePin: (name) =>
    set((state) => {
      const pinnedSet = new Set(state.pinnedSet)
      const pinnedOrder = [...state.pinnedOrder]
      if (pinnedSet.has(name)) {
        pinnedSet.delete(name)
        const idx = pinnedOrder.indexOf(name)
        if (idx >= 0) {
          pinnedOrder.splice(idx, 1)
        }
      } else {
        pinnedSet.add(name)
        pinnedOrder.push(name)
      }
      return { pinnedSet, pinnedOrder }
    }),

  movePinned: (name, index) =>
    set((state) => {
      const order = [...state.pinnedOrder]
      const from = order.indexOf(name)
      if (from === -1) {
        return state
      }
      order.splice(from, 1)
      order.splice(Math.max(0, Math.min(index, order.length)), 0, name)
      return { pinnedOrder: order }
    }),

  setEnabled: (name, next) =>
    set((state) => {
      const disabled = new Set(state.disabled)
      if (next) {
        disabled.delete(name)
      } else {
        disabled.add(name)
      }
      return { disabled }
    }),

  recordUsed: (name) =>
    set((state) => {
      const recent = [name, ...state.recent.filter((n) => n !== name)].slice(0, recentLimit)
      return { recent }
    }),

  addLocalSkill: (skill) =>
    set((state) => {
      const localOverrides = new Map(state.localOverrides)
      localOverrides.set(skill.name, {
        name: skill.name,
        source: 'local',
        description: skill.description,
        instruction: skill.instruction,
      })
      return { localOverrides }
    }),

  updateLocalSkill: (previousName, next) =>
    set((state) => {
      const localOverrides = new Map(state.localOverrides)
      localOverrides.delete(previousName)
      localOverrides.set(next.name, {
        name: next.name,
        source: 'local',
        description: next.description,
        instruction: next.instruction,
      })
      // Carry pin if the renamed skill was pinned
      const pinnedSet = new Set(state.pinnedSet)
      const pinnedOrder = [...state.pinnedOrder]
      if (previousName !== next.name && pinnedSet.has(previousName)) {
        pinnedSet.delete(previousName)
        pinnedSet.add(next.name)
        const idx = pinnedOrder.indexOf(previousName)
        if (idx >= 0) {
          pinnedOrder[idx] = next.name
        }
      }
      return { localOverrides, pinnedSet, pinnedOrder }
    }),

  markDeleted: (name) =>
    set((state) => {
      const deleted = new Set(state.deleted)
      deleted.add(name)
      const localOverrides = new Map(state.localOverrides)
      localOverrides.delete(name)
      return { deleted, localOverrides }
    }),
}))

// ---------- Selector hooks (adapter shape close to source for clean ports) ----------

export const useLibrarySkills = () => {
  const { localOverrides, deleted } = useSkillsStore(
    useShallow((s) => ({ localOverrides: s.localOverrides, deleted: s.deleted })),
  )
  const skills = buildLibrary(localOverrides, deleted)
  const addLocalSkill = useSkillsStore((s) => s.addLocalSkill)
  const updateLocalSkill = useSkillsStore((s) => s.updateLocalSkill)
  const markDeleted = useSkillsStore((s) => s.markDeleted)
  return { skills, addLocalSkill, updateLocalSkill, markDeleted }
}

export const usePinnedSkills = () => {
  const pinned = useSkillsStore((s) => s.pinnedOrder)
  const pinnedSet = useSkillsStore((s) => s.pinnedSet)
  const togglePin = useSkillsStore((s) => s.togglePin)
  const movePinned = useSkillsStore((s) => s.movePinned)
  return { pinned, pinnedSet, togglePin, movePinned }
}

export const useEnabledSkills = () => {
  const disabled = useSkillsStore((s) => s.disabled)
  const setEnabled = useSkillsStore((s) => s.setEnabled)
  const isEnabled = (name: string) => !disabled.has(name)
  return { isEnabled, setEnabled }
}

export const useRecentSkills = () => {
  const recent = useSkillsStore((s) => s.recent)
  const recordUsed = useSkillsStore((s) => s.recordUsed)
  return { recent, recordUsed }
}
