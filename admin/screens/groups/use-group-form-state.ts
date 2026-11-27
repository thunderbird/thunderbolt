/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useReducer, useRef } from 'react'
import { useAuth } from '@/contexts'
import {
  adminPageMaxSize,
  adminRole,
  type BreakGlassWarning,
  type LocalGroup,
  type UpdateGroupBody,
} from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { hasBreakGlassWarning } from '../../components/break-glass-banner'
import { isSelfDemotingGroupRemoval } from '../members/member-rules'
import type { GroupPanelState } from './use-group-panel-state'
import { useDebounce } from '@/hooks/use-debounce'
import { searchDebounceMs } from '../../api/search-debounce'

/** A person the form adds or keeps: enough to show them before the group's own list does. */
export type DraftMember = { userId: string; label: string; detail?: string }

type GroupDraft = {
  name: string
  description: string
  isAdmin: boolean
  /** Members to add on save, in the order they were picked. */
  added: DraftMember[]
  /** Current members to remove on save. */
  removed: string[]
}

type SaveResult = { groupId: string; warning: boolean }

type Touched = { name: boolean; description: boolean; isAdmin: boolean }

type GroupFormFields = { draft: GroupDraft; touched: Touched; search: string }

type GroupFormAction =
  | { type: 'edit'; field: keyof Touched; value: string | boolean }
  | { type: 'follow'; saved: Partial<GroupDraft> }
  | { type: 'members'; added: DraftMember[]; removed: string[] }
  | { type: 'search'; value: string }

/** The form's fields: an admin's edit marks the field touched, so it stops following the saved value. */
const groupFormReducer = (state: GroupFormFields, action: GroupFormAction): GroupFormFields => {
  switch (action.type) {
    case 'edit':
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
        touched: { ...state.touched, [action.field]: true },
      }
    case 'follow':
      return { ...state, draft: { ...state.draft, ...action.saved } }
    case 'members':
      return { ...state, draft: { ...state.draft, added: action.added, removed: action.removed } }
    case 'search':
      return { ...state, search: action.value }
  }
}

/**
 * What a save has applied to the group so far. A save that creates a group and then fails keeps
 * this, so the retry updates that group and runs only the steps that didn't finish.
 */
type AppliedGroup = { group: LocalGroup; adminMappingId: string | null; memberIds: string[] }

/**
 * The edit or create form of a group: name, description, the admin role and the members, held as
 * a draft and applied together on Save. For a group that exists, Save sends only what this admin
 * changed, so a field they left alone never undoes another admin's edit to it.
 */
export const useGroupFormState = (
  panel: GroupPanelState,
  { onDirtyChange, onSaved }: { onDirtyChange: (dirty: boolean) => void; onSaved: (result: SaveResult) => void },
) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const group: LocalGroup | undefined = panel.group.data
  const savedIsAdmin = panel.adminMapping !== undefined
  const savedName = group?.name ?? ''
  const savedDescription = group?.description ?? ''
  const [{ draft, touched, search }, dispatch] = useReducer(groupFormReducer, undefined, () => ({
    draft: { name: savedName, description: savedDescription, isAdmin: savedIsAdmin, added: [], removed: [] },
    touched: { name: false, description: false, isAdmin: false },
    search: '',
  }))
  // Until the admin edits them, the fields follow the saved values: they load after the form
  // opens, and a refresh may bring in another admin's change.
  const followed = {
    ...(!touched.name && draft.name !== savedName && { name: savedName }),
    ...(!touched.description && draft.description !== savedDescription && { description: savedDescription }),
    ...(!touched.isAdmin && draft.isAdmin !== savedIsAdmin && { isAdmin: savedIsAdmin }),
  }
  if (Object.keys(followed).length > 0) {
    dispatch({ type: 'follow', saved: followed })
  }
  const q = useDebounce(search.trim(), searchDebounceMs) || undefined
  const created = useRef<AppliedGroup | null>(null)

  const memberIds = new Set(panel.members.items.map((member) => member.userId))
  const candidates = useQuery({
    queryKey: adminQueryKeys.members.list(q),
    queryFn: () => api.members.list({ q, limit: adminPageMaxSize }),
  })
  const selfId = useAuth().useSession().data?.user.id ?? null
  const isSelfInGroup = selfId !== null && memberIds.has(selfId)
  const self = useQuery({
    queryKey: adminQueryKeys.members.detail(selfId ?? ''),
    queryFn: () => api.members.get(selfId!),
    enabled: isSelfInGroup,
  })

  const name = draft.name.trim()
  const description = draft.description.trim()
  const isDraftDirty = (next: GroupDraft) =>
    next.name.trim() !== savedName ||
    next.description.trim() !== savedDescription ||
    next.isAdmin !== savedIsAdmin ||
    next.added.length > 0 ||
    next.removed.length > 0

  const update = (action: GroupFormAction) => {
    dispatch(action)
    onDirtyChange(isDraftDirty(groupFormReducer({ draft, touched, search }, action).draft))
  }

  /**
   * Whether saving takes admin away from the signed-in admin: they leave the group, or the group
   * stops being admin, and it's their only admin source. Until their own detail loads, it counts
   * as demoting, so the confirm errs on the side of asking.
   */
  const isSelfDemoting =
    group !== undefined &&
    isSelfInGroup &&
    savedIsAdmin &&
    (draft.removed.includes(selfId) || !draft.isAdmin) &&
    (!self.data || isSelfDemotingGroupRemoval(self.data, group.id))

  /** Create the group, or update what changed on the one this form edits or an earlier save created. */
  const saveDetails = async (base: LocalGroup | null): Promise<LocalGroup> => {
    if (!base) {
      return api.groups.create({ name, description })
    }
    const edited: UpdateGroupBody = {
      ...(name !== base.name && { name }),
      ...(description !== (base.description ?? '') && { description }),
    }
    return Object.keys(edited).length > 0 ? api.groups.update(base.id, edited) : base
  }

  const save = useMutation({
    // Admin is granted first and taken away last. Removing the signed-in admin themselves runs after
    // everything else, so the one step that may demote them is the last one.
    mutationFn: async (): Promise<SaveResult> => {
      const warnings: BreakGlassWarning[] = []
      const base = group
        ? { group, adminMappingId: panel.adminMapping?.id ?? null, memberIds: [...memberIds] }
        : created.current
      const saved = await saveDetails(base?.group ?? null)
      const applied: AppliedGroup = { adminMappingId: null, memberIds: [], ...base, group: saved }
      if (!group) {
        created.current = applied
      }
      queryClient.setQueryData(adminQueryKeys.groups.detail(saved.id), saved)
      // A group this form created holds only the people picked for it: anyone an earlier failed save
      // added and the admin has since taken off the list goes.
      const wantedIds = new Set(
        [...(group ? memberIds : []), ...draft.added.map((member) => member.userId)].filter(
          (userId) => !draft.removed.includes(userId),
        ),
      )
      const removedIds = applied.memberIds.filter((userId) => !wantedIds.has(userId))
      const removeMember = async (userId: string) => {
        warnings.push(await api.groups.removeMember(saved.id, userId))
        applied.memberIds = applied.memberIds.filter((id) => id !== userId)
      }
      if (draft.isAdmin && !applied.adminMappingId) {
        const mapping = await api.roleMappings.create({ localGroupId: saved.id, role: adminRole })
        applied.adminMappingId = mapping.id
        warnings.push(mapping)
      }
      for (const member of draft.added.filter((added) => !applied.memberIds.includes(added.userId))) {
        await api.groups.addMember(saved.id, member.userId)
        applied.memberIds = [...applied.memberIds, member.userId]
      }
      for (const userId of removedIds.filter((id) => id !== selfId)) {
        await removeMember(userId)
      }
      if (!draft.isAdmin && applied.adminMappingId) {
        warnings.push(await api.roleMappings.remove(applied.adminMappingId))
        applied.adminMappingId = null
      }
      if (selfId !== null && removedIds.includes(selfId)) {
        await removeMember(selfId)
      }
      return { groupId: saved.id, warning: warnings.some(hasBreakGlassWarning) }
    },
    // A save that fails halfway has still applied its first steps, so refresh either way.
    onSettled: () =>
      Promise.all(
        [
          adminQueryKeys.groups.all,
          adminQueryKeys.members.all,
          adminQueryKeys.roleMappings.all,
          adminQueryKeys.connections.all,
          adminQueryKeys.breakGlass,
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    onSuccess: (result) => {
      onDirtyChange(false)
      onSaved(result)
    },
  })

  const addedIds = new Set(draft.added.map((member) => member.userId))
  return {
    draft,
    isNew: group === undefined,
    canSave: name !== '' && (group === undefined || isDraftDirty(draft)) && !save.isPending,
    isSelfDemoting,
    save,
    setName: (value: string) => update({ type: 'edit', field: 'name', value }),
    setDescription: (value: string) => update({ type: 'edit', field: 'description', value }),
    setIsAdmin: (value: boolean) => update({ type: 'edit', field: 'isAdmin', value }),
    search,
    setSearch: (value: string) => dispatch({ type: 'search', value }),
    isSearching: candidates.isFetching,
    /** Members matching the search who aren't in the group or already picked. */
    candidates: (candidates.data?.items ?? []).filter(
      (member) =>
        (!memberIds.has(member.userId) || draft.removed.includes(member.userId)) && !addedIds.has(member.userId),
    ),
    addMembers: (members: DraftMember[]) =>
      update({
        type: 'members',
        added: [...draft.added, ...members.filter((member) => !memberIds.has(member.userId))],
        removed: draft.removed.filter((userId) => !members.some((member) => member.userId === userId)),
      }),
    /** Take a picked person off the list, or mark a current member for removal. */
    removeMember: (userId: string) =>
      update({
        type: 'members',
        added: addedIds.has(userId) ? draft.added.filter((member) => member.userId !== userId) : draft.added,
        removed: addedIds.has(userId) ? draft.removed : [...draft.removed, userId],
      }),
  }
}

export type GroupFormState = ReturnType<typeof useGroupFormState>
