/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import {
  createSkill,
  getAllSkills,
  getPinnedSkills,
  reorderPins,
  setSkillEnabled,
  setSkillPinned,
  softDeleteSkill,
  updateSkill,
  type CreateSkillInput,
  type UpdateSkillInput,
} from '@/dal'
import type { Skill } from '@/types'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

// PowerSync's `useQuery` *should* re-run when the underlying SQLite table
// changes, but in practice we've seen the cache not invalidate immediately
// after a write — the new row only shows up after a manual reload. Explicit
// invalidation via React Query keeps the UI in sync without waiting for the
// PowerSync table-change signal.
const skillsQueryKey = ['skills']

/**
 * Library of non-deleted skills + mutations to create / update / soft-delete.
 */
export const useLibrarySkills = () => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: skillsQueryKey })

  const { data: skills = [], isLoading } = useQuery({
    queryKey: skillsQueryKey,
    query: toCompilableQuery(getAllSkills(db)),
  })

  const create = useMutation({
    mutationFn: (input: CreateSkillInput) => createSkill(db, input),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSkillInput }) => updateSkill(db, id, patch),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => softDeleteSkill(db, id),
    onSuccess: invalidate,
  })

  return {
    skills: skills as Skill[],
    isLoading,
    createSkill: create.mutateAsync,
    updateSkill: update.mutateAsync,
    softDeleteSkill: remove.mutateAsync,
  }
}

/**
 * Pinned skills (in `pinned_order`) + pin / unpin / reorder mutations.
 * `pinnedSet` is a `Set<string>` of pinned skill ids for O(1) `has()` checks
 * from list / detail rendering.
 */
export const usePinnedSkills = () => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: skillsQueryKey })

  const { data: pinned = [] } = useQuery({
    queryKey: [...skillsQueryKey, 'pinned'],
    query: toCompilableQuery(getPinnedSkills(db)),
  })
  const pinnedSkills = pinned as Skill[]

  const pinnedSet = useMemo(() => new Set(pinnedSkills.map((s) => s.id)), [pinnedSkills])

  const pin = useMutation({
    mutationFn: ({ id, order }: { id: string; order: number | null }) => setSkillPinned(db, id, order),
    onSuccess: invalidate,
  })
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderPins(db, ids),
    onSuccess: invalidate,
  })

  /**
   * Toggle pin state. Pins land at the next available position (current count).
   * Throws `PinLimitExceededError` if the cap is reached — callers should
   * surface this inline on the trigger control.
   */
  const togglePin = async (id: string) => {
    if (pinnedSet.has(id)) {
      await pin.mutateAsync({ id, order: null })
    } else {
      await pin.mutateAsync({ id, order: pinnedSkills.length })
    }
  }

  return {
    pinned: pinnedSkills,
    pinnedSet,
    togglePin,
    reorderPins: reorder.mutateAsync,
  }
}

/**
 * Enabled-state lookup + toggle. Reads from the same library query so it
 * stays in lockstep with {@link useLibrarySkills}; no separate fetch.
 */
export const useEnabledSkills = () => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: skillsQueryKey })
  const { skills } = useLibrarySkills()

  const enabledById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const skill of skills) {
      map.set(skill.id, skill.enabled === 1)
    }
    return map
  }, [skills])

  const set = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => setSkillEnabled(db, id, next),
    onSuccess: invalidate,
  })

  const isEnabled = (id: string) => enabledById.get(id) ?? true
  const setEnabled = (id: string, next: boolean) => set.mutateAsync({ id, next })

  return { isEnabled, setEnabled }
}
