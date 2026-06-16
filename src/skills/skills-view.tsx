/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { Plus } from 'lucide-react'
import { useCallback, useReducer, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import { useWorkspacePermission } from '@/hooks/use-workspace-permission'
import { DeleteSkillDialog } from './delete-skill-dialog'
import { DependentsDialog } from './dependents-dialog'
import { DiscardCreateDialog } from './discard-create-dialog'
import { findDependents } from './find-dependents'
import { SkillDetail } from './skill-detail'
import { SkillForm, type SkillFormValues } from './skill-form'
import { initialSkillsViewState, skillsViewReducer } from './skills-view-state'
import { SkillsList } from './skills-list'
import { useSkillTelemetry } from './telemetry'
import { useEnabledSkills, useLibrarySkills, usePinnedSkills } from './use-skills'

export const SkillsView = () => {
  const { isMobile } = useIsMobile()
  const { skills, createSkill, updateSkill, softDeleteSkill } = useLibrarySkills()
  // Pinning is managed entirely from the chat composer; we only read
  // `pinnedSet` here to auto-unpin on disable (a disabled skill can't be
  // summoned from the chat pinned bar, so keeping its slot would waste
  // one of the 10 available).
  const { pinnedSet, togglePin } = usePinnedSkills()
  const { isEnabled, setEnabled } = useEnabledSkills()
  const trackSkillEvent = useSkillTelemetry()
  // Workspace `add_skills` / `remove_skills` — BE enforces; FE hides
  // affordances so the user isn't presented with actions that round-trip-fail.
  const { isAllowed: canAddSkills } = useWorkspacePermission('add_skills')
  const { isAllowed: canRemoveSkills } = useWorkspacePermission('remove_skills')

  const [state, dispatch] = useReducer(skillsViewReducer, initialSkillsViewState)
  const {
    mode,
    activeId,
    mobileView,
    isDirty,
    resetSignal,
    pendingLeave,
    pendingDelete,
    pendingDependents,
    nameError,
    createInitialName,
  } = state

  // Deep-link from the chat composer's broken-reference alerts —
  // `editSkill` selects an existing (disabled) skill so the user can enable
  // it; `createSkill` opens the create form pre-filled with the slug the
  // user just typed. Both consume the router state once on mount and clear
  // it so back/forward doesn't re-trigger. Mirrors the `runSkill` pattern
  // in chat-prompt-input.
  const navigate = useNavigate()
  const location = useLocation()
  const consumedEditSkillRef = useRef<string | null>(null)
  const consumedCreateSkillRef = useRef<string | null>(null)
  const navState = (location.state ?? null) as { editSkill?: string; createSkill?: string } | null
  const editSkillNav = navState?.editSkill
  const createSkillNav = navState?.createSkill
  if (!editSkillNav) {
    consumedEditSkillRef.current = null
  } else if (consumedEditSkillRef.current !== editSkillNav) {
    consumedEditSkillRef.current = editSkillNav
    queueMicrotask(() => {
      dispatch({ type: 'SELECT_SKILL', id: editSkillNav })
      navigate(location.pathname, { replace: true, state: {} })
    })
  }
  if (!createSkillNav) {
    consumedCreateSkillRef.current = null
  } else if (consumedCreateSkillRef.current !== createSkillNav) {
    consumedCreateSkillRef.current = createSkillNav
    queueMicrotask(() => {
      dispatch({ type: 'START_CREATE', initialName: createSkillNav })
      navigate(location.pathname, { replace: true, state: {} })
    })
  }

  // `.at(0)` returns `Skill | undefined` honestly — `[0]` would be typed as
  // `Skill` even on an empty array (no `noUncheckedIndexedAccess` in tsconfig),
  // and a `| undefined` annotation wouldn't widen the rhs. Forcing undefined
  // into the type means TS catches every unguarded `active.*` access.
  const active = skills.find((s) => s.id === activeId) ?? skills.at(0)

  // Disabling a pinned skill auto-unpins it. Re-enabling does NOT auto-repin;
  // the user pins again deliberately from the chat composer.
  const disableSkill = useCallback(
    async (id: string) => {
      await setEnabled(id, false)
      if (pinnedSet.has(id)) {
        await togglePin(id)
      }
    },
    [setEnabled, pinnedSet, togglePin],
  )

  const handleToggleEnabled = useCallback(
    async (id: string, next: boolean) => {
      if (!next) {
        const target = skills.find((s) => s.id === id)
        const dependents = target ? findDependents(target.name, skills) : []
        if (target && dependents.length > 0) {
          dispatch({ type: 'OPEN_DEPENDENTS', payload: { action: 'disable', skill: target, dependents } })
          return
        }
        await disableSkill(id)
        return
      }
      await setEnabled(id, next)
    },
    [setEnabled, disableSkill, skills],
  )

  const requestLeave = useCallback(
    (leave: { type: 'cancel' } | { type: 'select'; id: string }) => {
      if ((mode === 'create' || mode === 'edit') && isDirty) {
        dispatch({ type: 'REQUEST_LEAVE', leave })
      } else {
        dispatch({ type: 'PERFORM_LEAVE', leave, isMobile })
      }
    },
    [mode, isDirty, isMobile],
  )

  const onSelectSkill = (id: string) => {
    if (mode === 'detail') {
      dispatch({ type: 'SELECT_SKILL', id })
    } else {
      requestLeave({ type: 'select', id })
    }
  }

  const onConfirmDiscard = () => {
    if (pendingLeave) {
      dispatch({ type: 'PERFORM_LEAVE', leave: pendingLeave, isMobile })
    }
  }

  const onEdit = (id: string) => {
    dispatch({ type: 'START_EDIT', id })
  }

  const onDelete = (id: string) => {
    const target = skills.find((s) => s.id === id)
    if (!target) {
      return
    }
    const dependents = findDependents(target.name, skills)
    if (dependents.length > 0) {
      dispatch({ type: 'OPEN_DEPENDENTS', payload: { action: 'delete', skill: target, dependents } })
    } else {
      dispatch({ type: 'OPEN_DELETE', skill: target })
    }
  }

  // `softDeleteSkill` already nulls `pinnedOrder` in the same write, so no
  // explicit unpin call is needed here — that would be a redundant write on
  // the tombstone row.
  const removeSkill = useCallback(
    async (id: string) => {
      await softDeleteSkill(id)
      trackSkillEvent('skill_deleted', id, {})
    },
    [softDeleteSkill, trackSkillEvent],
  )

  const confirmPendingDependents = async () => {
    if (!pendingDependents) {
      return
    }
    const { action, skill } = pendingDependents
    dispatch({ type: 'CLOSE_DEPENDENTS' })
    if (action === 'disable') {
      await disableSkill(skill.id)
    } else {
      await removeSkill(skill.id)
    }
  }

  const onJumpToDependent = (id: string) => {
    dispatch({ type: 'JUMP_TO_DEPENDENT', id, isMobile })
  }

  const handleSubmit = async (values: SkillFormValues) => {
    try {
      if (mode === 'create') {
        const created = await createSkill(values)
        trackSkillEvent('skill_created', created.id, { instruction_length: values.instruction.length })
        dispatch({ type: 'SUBMIT_SUCCESS', activeId: created.id })
      } else if (active) {
        const renamed = values.name !== active.name
        await updateSkill({ id: active.id, patch: values })
        trackSkillEvent('skill_edited', active.id, { renamed })
        dispatch({ type: 'SUBMIT_SUCCESS', activeId: active.id })
      }
    } catch (error) {
      if (error instanceof SkillNameTakenError || error instanceof SkillNameInvalidError) {
        dispatch({ type: 'SET_NAME_ERROR', message: error.message })
        return
      }
      throw error
    }
  }

  // Empty-state panel — the "I deleted everything" path. `active` falls back
  // to `skills.at(0)` (see below), so when the library has rows the panel
  // always renders a skill detail; this empty state only fires when
  // `skills.length === 0`. Stays inside the master/detail layout so the
  // list (and its + button) keep their normal position.
  const emptyPanel = (
    <section className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <h2 className="text-xl">No skills yet</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Skills are reusable instruction templates you summon in chat with{' '}
        <code className="rounded-sm bg-secondary px-1 font-mono text-xs">/name</code>.
      </p>
      {canAddSkills && (
        <Button size="sm" onClick={() => dispatch({ type: 'START_CREATE' })}>
          <Plus />
          Create your first skill
        </Button>
      )}
    </section>
  )

  const createForm = (
    <SkillForm
      // Keying on the pre-filled slug forces a fresh form mount when the
      // user clicks "Create it" for a different slug back-to-back.
      key={createInitialName ? `create:${createInitialName}` : 'create'}
      mode="create"
      initialValues={createInitialName ? { name: createInitialName, description: '', instruction: '' } : undefined}
      onCancel={() => requestLeave({ type: 'cancel' })}
      onSubmit={handleSubmit}
      onDirtyChange={(dirty) => dispatch({ type: 'SET_DIRTY', dirty })}
      onNameChange={() => dispatch({ type: 'CLEAR_NAME_ERROR' })}
      resetSignal={resetSignal}
      nameError={nameError}
    />
  )

  const panel =
    mode === 'create' ? (
      createForm
    ) : !active ? (
      emptyPanel
    ) : mode === 'detail' ? (
      <SkillDetail
        name={active.name}
        description={active.description}
        instruction={active.instruction}
        enabled={isEnabled(active.id)}
        canEdit={canAddSkills}
        canDelete={canRemoveSkills}
        onToggleEnabled={(next) => handleToggleEnabled(active.id, next)}
        onEdit={() => onEdit(active.id)}
        onDelete={() => onDelete(active.id)}
        onBack={isMobile ? () => dispatch({ type: 'BACK_TO_LIST' }) : undefined}
      />
    ) : (
      <SkillForm
        key={`edit:${active.id}`}
        mode="edit"
        initialValues={{
          name: active.name,
          description: active.description,
          instruction: active.instruction,
        }}
        onCancel={() => requestLeave({ type: 'cancel' })}
        onSubmit={handleSubmit}
        onDirtyChange={(dirty) => dispatch({ type: 'SET_DIRTY', dirty })}
        onNameChange={() => dispatch({ type: 'CLEAR_NAME_ERROR' })}
        resetSignal={resetSignal}
        nameError={nameError}
      />
    )

  return (
    <div className="relative flex h-full">
      <SkillsList
        skills={skills}
        activeSkillId={mode === 'detail' && active ? active.id : null}
        isEnabled={isEnabled}
        canCreate={canAddSkills}
        canEdit={canAddSkills}
        canDelete={canRemoveSkills}
        onToggleEnabled={handleToggleEnabled}
        onCreate={() => {
          if ((mode === 'create' || mode === 'edit') && isDirty) {
            return
          }
          dispatch({ type: 'START_CREATE' })
        }}
        onSelectSkill={onSelectSkill}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      {!isMobile && panel}
      {isMobile && (
        <AnimatePresence>
          {mobileView === 'panel' && (
            <m.div
              key="mobile-panel"
              className="absolute inset-0 z-10 flex bg-background"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 35, stiffness: 400, mass: 0.8 }}
            >
              {panel}
            </m.div>
          )}
        </AnimatePresence>
      )}
      {pendingDependents && (
        <DependentsDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              dispatch({ type: 'CLOSE_DEPENDENTS' })
            }
          }}
          action={pendingDependents.action}
          targetName={pendingDependents.skill.name}
          dependents={pendingDependents.dependents}
          onConfirm={confirmPendingDependents}
          onJumpToDependent={onJumpToDependent}
        />
      )}
      {pendingDelete && (
        <DeleteSkillDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              dispatch({ type: 'CLOSE_DELETE' })
            }
          }}
          onConfirm={() => {
            void removeSkill(pendingDelete.id)
            dispatch({ type: 'CLOSE_DELETE' })
          }}
          skillName={pendingDelete.name}
        />
      )}
      <DiscardCreateDialog
        open={pendingLeave !== null}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: 'CANCEL_DISCARD' })
          }
        }}
        onConfirm={onConfirmDiscard}
        title={mode === 'edit' ? 'Leave without saving?' : 'Leave without creating?'}
        description={mode === 'edit' ? "Your changes won't be saved." : "You'll lose what you've added so far."}
      />
    </div>
  )
}
