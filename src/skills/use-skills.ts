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
import { isHiddenSystemSkill } from '@/defaults/skills'
import type { Skill } from '@/types'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef } from 'react'

// `@powersync/tanstack-react-query` auto-invalidates this query whenever the
// `skills` table fires a `tablesUpdated` event (Drizzle writes through
// PowerSync's `writeLock`, which routes through SQLite's commit hook). That
// path *does* fire — but PowerSync wraps the listener in a 30ms
// `throttleTrailing` (`DEFAULT_WATCH_THROTTLE_MS` in `@powersync/common`),
// so the row a mutation just wrote can miss the very next render. Explicit
// invalidation on mutation success cuts that to zero latency.
const skillsQueryKey = ['skills']

/** Position after the last pin in an ascending list. Stored positions can have gaps. */
export const nextPinnedOrder = (pinned: ReadonlyArray<Pick<Skill, 'pinnedOrder'>>): number =>
  (pinned.at(-1)?.pinnedOrder ?? -1) + 1

/**
 * Rows for a mounted library view. A row stays listed once shown, so re-enabling
 * or reverting a system skill doesn't remove it while the user is managing it.
 */
export const useStickySkills = (visibleSkills: Skill[], allSkills: Skill[]): Skill[] => {
  const shownIds = useRef(new Set<string>())
  return useMemo(() => {
    visibleSkills.forEach((skill) => shownIds.current.add(skill.id))
    return allSkills.filter((skill) => shownIds.current.has(skill.id))
  }, [visibleSkills, allSkills])
}

/**
 * Read-only subscription to all non-deleted skills. Shared by
 * {@link useLibrarySkills} and {@link useEnabledSkills} so co-located callers
 * don't register duplicate `useMutation`s for create/update/remove they won't
 * use — React Query already deduplicates the underlying query by key.
 */
const useSkillsQuery = () => {
  const db = useDatabase()
  const { data: skills = [], isLoading } = useQuery({
    queryKey: skillsQueryKey,
    query: toCompilableQuery(getAllSkills(db)),
  })
  const allSkills = skills as Skill[]
  const visibleSkills = useMemo(() => allSkills.filter((skill) => !isHiddenSystemSkill(skill)), [allSkills])
  return { allSkills, visibleSkills, isLoading }
}

/**
 * Library of non-deleted skills + mutations to create / update / soft-delete.
 * `skills` is what users browse; `allSkills` also holds hidden system skills
 * and resolves tokens typed in the composer.
 */
export const useLibrarySkills = () => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: skillsQueryKey })
  const { allSkills, visibleSkills, isLoading } = useSkillsQuery()

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
    skills: visibleSkills,
    allSkills,
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
   * Toggle pin state. Pins land after the last pin.
   * Throws `PinLimitExceededError` if the cap is reached — callers should
   * surface this inline on the trigger control.
   */
  const togglePin = async (id: string) => {
    if (pinnedSet.has(id)) {
      await pin.mutateAsync({ id, order: null })
    } else {
      await pin.mutateAsync({ id, order: nextPinnedOrder(pinnedSkills) })
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
 * Enabled-state lookup + toggle. Subscribes to the shared library query (not
 * `useLibrarySkills`) so co-located callers don't register the create/update/
 * remove mutations they won't use.
 */
export const useEnabledSkills = () => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: skillsQueryKey })
  const { allSkills } = useSkillsQuery()

  const enabledById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const skill of allSkills) {
      map.set(skill.id, skill.enabled === 1)
    }
    return map
  }, [allSkills])

  const set = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => setSkillEnabled(db, id, next),
    onSuccess: invalidate,
  })

  const isEnabled = (id: string) => enabledById.get(id) ?? true
  const setEnabled = (id: string, next: boolean) => set.mutateAsync({ id, next })

  return { isEnabled, setEnabled }
}
