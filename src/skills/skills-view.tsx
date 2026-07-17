/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useReducer, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { SlideInPanel } from '@/components/slide-in-panel'
import { SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import { DeleteSkillDialog } from './delete-skill-dialog'
import { DependentsDialog } from './dependents-dialog'
import { DiscardCreateDialog } from './discard-create-dialog'
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
  // `''` is a valid deep link (open a blank create form — e.g. the chat
  // skills bar's "New skill" row), so only null/undefined mean "no link".
  if (createSkillNav == null) {
    consumedCreateSkillRef.current = null
  } else if (consumedCreateSkillRef.current !== createSkillNav) {
    consumedCreateSkillRef.current = createSkillNav
    queueMicrotask(() => {
      dispatch({ type: 'START_CREATE', initialName: createSkillNav || undefined })
      navigate(location.pathname, { replace: true, state: {} })
    })
  }

  // No first-skill fallback: the detail panel only opens when the user
  // explicitly selects a skill (or a deep link does), matching the
  // slide-in-from-the-right behavior. `undefined` means "nothing selected".
  const active = skills.find((s) => s.id === activeId)

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

  // Edit/create from a dirty form routes through the discard dialog like
  // `onSelectSkill` — never a silent dead click.
  const onEdit = (id: string) => {
    if (mode === 'detail') {
      dispatch({ type: 'START_EDIT', id })
    } else {
      requestLeave({ type: 'edit', id })
    }
  }

  const onCreate = () => {
    if (mode === 'detail') {
      dispatch({ type: 'START_CREATE' })
    } else {
      requestLeave({ type: 'create' })
    }
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
    dispatch({ type: 'JUMP_TO_DEPENDENT', id })
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

  const renderPanel = () => {
    if (mode === 'create') {
      return createForm
    }
    if (!active) {
      return null
    }
    if (mode === 'detail') {
      return (
        <SkillDetail
          name={active.name}
          description={active.description}
          instruction={active.instruction}
          onEdit={() => onEdit(active.id)}
          onDelete={() => onDelete(active.id)}
          onClose={() => dispatch({ type: 'BACK_TO_LIST' })}
        />
      )
    }
    return (
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
  }

  const panel = renderPanel()
  const panelOpen = panelView === 'panel' && panel !== null

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SkillsList
          skills={skills}
          activeSkillId={panelOpen && mode === 'detail' && active ? active.id : null}
          isEnabled={isEnabled}
          onToggleEnabled={handleToggleEnabled}
          onCreate={onCreate}
          onSelectSkill={onSelectSkill}
          onEditSkill={onEdit}
          onDeleteSkill={onDelete}
        />
      </div>
      {/* ~50/50 split with the list: half the viewport minus half the sidebar. */}
      {!isMobile && (
        <SlideInPanel open={panelOpen} width="clamp(400px, calc(50vw - 128px), 800px)">
          {/* One continuous surface for the whole detail column, lifted off the
              page by the app's soft glow shadow plus a faint border. bg-sidebar
              (near-white in light mode) like the chat composer, so the surface
              reads against the page in both themes. Bottom padding floats the
              card off the window edge; the right edge stays flush and square —
              only the left corners are rounded. */}
          <div className="h-full pb-4">
            <div className="h-full overflow-hidden rounded-l-2xl border border-r-0 border-border/60 bg-sidebar shadow-glow">
              {panel}
            </div>
          </div>
        </SlideInPanel>
      )}
      {isMobile && (
        <AnimatePresence>
          {panelOpen && (
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
