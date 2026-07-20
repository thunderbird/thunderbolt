/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useReducer } from 'react'

import { DetailPanelSurface } from '@/components/detail-panel'
import { SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { useConsumeNavState } from '@/hooks/use-consume-nav-state'
import { useIsMobile } from '@/hooks/use-mobile'
import { DeleteSkillDialog } from './delete-skill-dialog'
import { DependentsDialog } from './dependents-dialog'
import { DiscardCreateDialog } from './discard-create-dialog'
import { skillDisplayName, titleCaseFromSlug } from './display'
import { findDependents } from './find-dependents'
import { SkillDetail } from './skill-detail'
import { SkillForm, type SkillFormValues } from './skill-form'
import { initialSkillsViewState, skillsViewReducer, type LeaveIntent } from './skills-view-state'
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

  const [state, dispatch] = useReducer(skillsViewReducer, initialSkillsViewState)
  const {
    mode,
    activeId,
    panelView,
    isDirty,
    resetSignal,
    pendingLeave,
    pendingDelete,
    pendingDependents,
    slugError,
    submitError,
    createInitialName,
  } = state

  // Deep-links from the chat composer. Broken-reference alerts send
  // `editSkill` (selects an existing, likely disabled skill so the user can
  // enable it) or `createSkill` (opens the create form pre-filled with the
  // slug the user just typed — `''` opens a blank form); the pinned chips'
  // "Edit skill" action sends `startEditSkill`, which lands straight in the
  // edit form. Same consume-once pattern as `runSkill` in chat-prompt-input.
  useConsumeNavState('editSkill', (id) => dispatch({ type: 'SELECT_SKILL', id }))
  useConsumeNavState('startEditSkill', (id) => dispatch({ type: 'START_EDIT', id }))
  useConsumeNavState('createSkill', (slug) => dispatch({ type: 'START_CREATE', initialName: slug || undefined }))

  // No first-skill fallback: the detail panel only opens when the user
  // explicitly selects a skill (or a deep link does), matching the
  // slide-in-from-the-right behavior. `undefined` means "nothing selected".
  const activeSkill = skills.find((s) => s.id === activeId)

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

  const toggleEnabled = useCallback(
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

  // Fire-and-forget from the row's perspective, but a failed DB write must
  // not vanish silently — surface it in the console instead of dropping the
  // rejected promise on the floor.
  const handleToggleEnabled = useCallback(
    (id: string, next: boolean) => {
      toggleEnabled(id, next).catch((error: unknown) => {
        console.error('Failed to toggle skill enabled state', error)
      })
    },
    [toggleEnabled],
  )

  const requestLeave = useCallback(
    (leave: LeaveIntent) => {
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

  // Edit/create always route through `requestLeave`: from a clean state it
  // performs the leave immediately (opening the form), and from a dirty form
  // it parks the intent behind the discard dialog — never a silent dead click.
  const onEdit = (id: string) => requestLeave({ type: 'edit', id })

  const onCreate = () => requestLeave({ type: 'create' })

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

  const confirmPendingDependents = () => {
    if (!pendingDependents) {
      return
    }
    const { action, skill } = pendingDependents
    dispatch({ type: 'CLOSE_DEPENDENTS' })
    // The dialog is already closed, so a failed write can't be shown there —
    // but it must not vanish as a dropped rejection either.
    const run = action === 'disable' ? disableSkill(skill.id) : removeSkill(skill.id)
    run.catch((error: unknown) => {
      console.error(`Failed to ${action} skill`, error)
    })
  }

  const onJumpToDependent = (id: string) => {
    dispatch({ type: 'JUMP_TO_DEPENDENT', id })
  }

  const handleSubmit = async (values: SkillFormValues) => {
    try {
      if (mode === 'create') {
        const created = await createSkill(values)
        trackSkillEvent('skill_created', created.id, { instruction_length: values.instruction.length })
        dispatch({ type: 'SUBMIT_SUCCESS', activeId: created.id })
      } else if (activeSkill) {
        const renamed = values.name !== activeSkill.name
        await updateSkill({ id: activeSkill.id, patch: values })
        trackSkillEvent('skill_edited', activeSkill.id, { renamed })
        dispatch({ type: 'SUBMIT_SUCCESS', activeId: activeSkill.id })
      }
    } catch (error) {
      if (error instanceof SkillNameTakenError || error instanceof SkillNameInvalidError) {
        dispatch({ type: 'SET_SLUG_ERROR', message: error.message })
        return
      }
      // Unexpected persistence failure: the form stays open with the user's
      // input intact — tell them why nothing happened instead of failing
      // silently as an unhandled rejection.
      console.error('Failed to save skill', error)
      dispatch({ type: 'SUBMIT_FAILED', message: "Couldn't save the skill. Please try again." })
    }
  }

  // Wiring shared by the create and edit forms — one source so the two
  // renders can't drift.
  const sharedFormProps = {
    onCancel: () => requestLeave({ type: 'cancel' }),
    onSubmit: handleSubmit,
    onDirtyChange: (dirty: boolean) => dispatch({ type: 'SET_DIRTY', dirty }),
    onSlugChange: () => dispatch({ type: 'CLEAR_SLUG_ERROR' }),
    resetSignal,
    slugError,
    submitError,
  }

  const createForm = (
    <SkillForm
      // Keying on the pre-filled slug forces a fresh form mount when the
      // user clicks "Create it" for a different slug back-to-back.
      key={createInitialName ? `create:${createInitialName}` : 'create'}
      mode="create"
      initialValues={
        createInitialName
          ? {
              name: createInitialName,
              // Suggest a Title Case name from the slug the user typed in chat.
              label: titleCaseFromSlug(createInitialName),
              description: '',
              instruction: '',
            }
          : undefined
      }
      {...sharedFormProps}
    />
  )

  const renderPanel = () => {
    if (mode === 'create') {
      return createForm
    }
    if (!activeSkill) {
      return null
    }
    if (mode === 'detail') {
      return (
        <SkillDetail
          name={skillDisplayName(activeSkill)}
          description={activeSkill.description}
          instruction={activeSkill.instruction}
          onEdit={() => onEdit(activeSkill.id)}
          onDelete={() => onDelete(activeSkill.id)}
          onClose={() => dispatch({ type: 'BACK_TO_LIST' })}
        />
      )
    }
    return (
      <SkillForm
        key={`edit:${activeSkill.id}`}
        mode="edit"
        initialValues={{
          name: activeSkill.name,
          // Legacy rows without a label get a Title Case suggestion so the
          // required Name field doesn't start empty.
          label: skillDisplayName(activeSkill),
          description: activeSkill.description,
          instruction: activeSkill.instruction,
        }}
        {...sharedFormProps}
      />
    )
  }

  const panel = renderPanel()
  const panelOpen = panelView === 'panel' && panel !== null

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SkillsList
          skills={skills}
          activeSkillId={panelOpen && mode === 'detail' && activeSkill ? activeSkill.id : null}
          isEnabled={isEnabled}
          onToggleEnabled={handleToggleEnabled}
          onCreate={onCreate}
          onSelectSkill={onSelectSkill}
          onEditSkill={onEdit}
          onDeleteSkill={onDelete}
        />
      </div>
      <DetailPanelSurface open={panelOpen} isMobile={isMobile}>
        {panel}
      </DetailPanelSurface>
      {pendingDependents && (
        <DependentsDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              dispatch({ type: 'CLOSE_DEPENDENTS' })
            }
          }}
          action={pendingDependents.action}
          targetName={skillDisplayName(pendingDependents.skill)}
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
            // The dialog closes immediately; a failed delete still surfaces
            // in the console rather than as a dropped rejection.
            removeSkill(pendingDelete.id).catch((error: unknown) => {
              console.error('Failed to delete skill', error)
            })
            dispatch({ type: 'CLOSE_DELETE' })
          }}
          skillName={skillDisplayName(pendingDelete)}
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
