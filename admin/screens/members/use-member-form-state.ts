/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  adminPageMaxSize,
  adminRole,
  type AdminMember,
  type BreakGlassWarning,
  type LocalGroup,
} from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { hasBreakGlassWarning } from '../../components/break-glass-banner'
import { hasAdminGrant, isNameIdpManaged, isSelfDemotingEdit } from './member-rules'

type MemberDraft = { name: string; isAdmin: boolean; groupIds: string[] }

/** Which fields the admin has edited. For the groups, the ids they started editing from. */
type Touched = { name: boolean; isAdmin: boolean; groupIds: string[] | null }

/** Whether two id lists hold the same ids, in any order. */
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id))

/** Whether the member holds admin through the local group `groupId`. */
const grantsAdminThrough = (member: AdminMember, groupId: string) =>
  member.roles.some(
    (source) => source.role === adminRole && source.from === 'local_group' && source.groupId === groupId,
  )

/**
 * The edit form of a member: their name, their own admin grant and their local groups, held as a
 * draft and applied together on Save. Until the admin edits a field it follows the saved value,
 * so a refresh that brings in another admin's change shows it; Save sends only what was changed.
 * Group changes are diffed against the groups the edit started from, so another admin's concurrent
 * add or remove is left alone rather than undone.
 */
export const useMemberFormState = (
  member: AdminMember,
  selfId: string | null,
  { onDirtyChange, onSaved }: { onDirtyChange: (dirty: boolean) => void; onSaved: (warning: boolean) => void },
) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const saved: MemberDraft = {
    name: member.name,
    isAdmin: hasAdminGrant(member),
    groupIds: member.groups.map((group) => group.id),
  }
  const [draft, setDraft] = useState(saved)
  const [touched, setTouched] = useState<Touched>({ name: false, isAdmin: false, groupIds: null })
  const followed = {
    ...(!touched.name && draft.name !== saved.name && { name: saved.name }),
    ...(!touched.isAdmin && draft.isAdmin !== saved.isAdmin && { isAdmin: saved.isAdmin }),
    ...(!touched.groupIds && !sameIds(draft.groupIds, saved.groupIds) && { groupIds: saved.groupIds }),
  }
  if (Object.keys(followed).length > 0) {
    setDraft({ ...draft, ...followed })
  }

  /** Every local group, following the cursor to the last page. */
  const fetchAllGroups = async (cursor?: string): Promise<LocalGroup[]> => {
    const page = await api.groups.list({ cursor, limit: adminPageMaxSize })
    return page.nextCursor ? [...page.items, ...(await fetchAllGroups(page.nextCursor))] : page.items
  }
  const groups = useQuery({
    queryKey: adminQueryKeys.groups.listAll(),
    // The groups API has no search, so the picker loads every page and filters locally.
    queryFn: () => fetchAllGroups(),
  })

  const name = draft.name.trim()
  const nameChanged = name !== saved.name
  const adminChanged = draft.isAdmin !== saved.isAdmin
  const groupChanges = (groupIds: string[], base: string[]) => ({
    joined: groupIds.filter((id) => !base.includes(id) && !saved.groupIds.includes(id)),
    left: base.filter((id) => !groupIds.includes(id) && saved.groupIds.includes(id)),
  })
  const { joined: joinedGroupIds, left: leftGroupIds } = groupChanges(
    draft.groupIds,
    touched.groupIds ?? saved.groupIds,
  )
  const isDirty = nameChanged || adminChanged || joinedGroupIds.length > 0 || leftGroupIds.length > 0

  const update = (next: Partial<MemberDraft>, nextTouched: Partial<Touched>) => {
    const merged = { ...draft, ...next }
    const mergedTouched = { ...touched, ...nextTouched }
    const changes = groupChanges(merged.groupIds, mergedTouched.groupIds ?? saved.groupIds)
    setTouched(mergedTouched)
    setDraft(merged)
    onDirtyChange(
      merged.name.trim() !== saved.name ||
        merged.isAdmin !== saved.isAdmin ||
        changes.joined.length > 0 ||
        changes.left.length > 0,
    )
  }

  const save = useMutation({
    mutationFn: async () => {
      // What keeps or grants admin runs first and what takes it away last: the revoke, then leaving
      // the groups that make them admin. Only the last of those can strip an admin editing themselves
      // of their final admin source, so no step runs after a demoting one.
      const warnings: BreakGlassWarning[] = []
      const leave = async (groupId: string) => {
        warnings.push(await api.groups.removeMember(groupId, member.userId))
      }
      if (nameChanged) {
        await api.members.update(member.userId, { name })
      }
      if (adminChanged && draft.isAdmin) {
        await api.members.grantRole(member.userId, adminRole)
      }
      for (const groupId of joinedGroupIds) {
        await api.groups.addMember(groupId, member.userId)
      }
      for (const groupId of leftGroupIds.filter((id) => !grantsAdminThrough(member, id))) {
        await leave(groupId)
      }
      if (adminChanged && !draft.isAdmin) {
        warnings.push(await api.members.revokeRole(member.userId, adminRole))
      }
      for (const groupId of leftGroupIds.filter((id) => grantsAdminThrough(member, id))) {
        await leave(groupId)
      }
      return warnings.some(hasBreakGlassWarning)
    },
    // A save that fails halfway has still applied its first steps, so refresh either way.
    onSettled: () =>
      Promise.all(
        [adminQueryKeys.members.all, adminQueryKeys.groups.all, adminQueryKeys.breakGlass].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
    onSuccess: (warning) => {
      onDirtyChange(false)
      onSaved(warning)
    },
  })

  return {
    draft,
    isNameIdpManaged: isNameIdpManaged(member),
    // The member's own groups too, so their chips show before the groups load.
    groupOptions: [
      ...member.groups,
      ...(groups.data ?? []).filter((group) => !member.groups.some((own) => own.id === group.id)),
    ].map((group) => ({ id: group.id, label: group.name })),
    groupsError: groups.error,
    // A member can have no name; only a rename has to give one.
    canSave: isDirty && (!nameChanged || name !== '') && !save.isPending,
    /** Whether saving takes the signed-in admin's own admin away, so the form confirms first. */
    isSelfDemoting: isSelfDemotingEdit(member, selfId, {
      revokesGrant: adminChanged && !draft.isAdmin,
      leftGroupIds,
    }),
    save,
    setName: (value: string) => update({ name: value }, { name: true }),
    setIsAdmin: (value: boolean) => update({ isAdmin: value }, { isAdmin: true }),
    setGroupIds: (ids: string[]) => update({ groupIds: ids }, { groupIds: touched.groupIds ?? saved.groupIds }),
  }
}

export type MemberFormState = ReturnType<typeof useMemberFormState>
