/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'

import { PinLimitExceededError, SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import type { Skill } from '@/types'
import { DeleteSkillDialog } from './delete-skill-dialog'
import { DependentsDialog, type DependentsAction } from './dependents-dialog'
import { DiscardCreateDialog } from './discard-create-dialog'
import { findDependents } from './find-dependents'
import { SkillDetail } from './skill-detail'
import { SkillForm, type SkillFormValues } from './skill-form'
import { SkillsList } from './skills-list'
import { useEnabledSkills, useLibrarySkills, usePinnedSkills } from './use-skills'

const pinErrorDismissMs = 4000

type Mode = 'detail' | 'create' | 'edit'

type PendingLeave = { type: 'cancel' } | { type: 'select'; id: string } | null

export const SkillsView = () => {
  const { isMobile } = useIsMobile()
  const { skills, createSkill, updateSkill, softDeleteSkill } = useLibrarySkills()
  const { pinned, pinnedSet, togglePin, reorderPins } = usePinnedSkills()
  const { isEnabled, setEnabled } = useEnabledSkills()
  const isPinned = useCallback((id: string) => pinnedSet.has(id), [pinnedSet])

  // Mobile uses a master/detail stack — list at the base, panel slides in.
  // Desktop ignores `mobileView` and always renders both side-by-side.
  const [mobileView, setMobileView] = useState<'list' | 'panel'>('list')
  const [mode, setMode] = useState<Mode>('detail')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [resetSignal, setResetSignal] = useState(0)
  const [pendingLeave, setPendingLeave] = useState<PendingLeave>(null)
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null)
  const [pendingDependents, setPendingDependents] = useState<{
    action: DependentsAction
    skill: Skill
    dependents: Skill[]
  } | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)

  useEffect(() => {
    if (!pinError) {
      return
    }
    const id = setTimeout(() => setPinError(null), pinErrorDismissMs)
    return () => clearTimeout(id)
  }, [pinError])

  const tryTogglePin = useCallback(
    async (id: string) => {
      try {
        await togglePin(id)
        setPinError(null)
      } catch (error) {
        if (error instanceof PinLimitExceededError) {
          setPinError(error.message)
          return
        }
        throw error
      }
    },
    [togglePin],
  )

  // `.at(0)` returns `Skill | undefined` honestly — `[0]` would be typed as
  // `Skill` even on an empty array (no `noUncheckedIndexedAccess` in tsconfig),
  // and a `| undefined` annotation wouldn't widen the rhs. Forcing undefined
  // into the type means TS catches every unguarded `active.*` access.
  const active = skills.find((s) => s.id === activeId) ?? skills.at(0)

  const handleToggleEnabled = useCallback(
    async (id: string, next: boolean) => {
      if (!next) {
        const skill = skills.find((s) => s.id === id)
        const dependents = skill ? findDependents(skill.name ?? '', skills) : []
        if (skill && dependents.length > 0) {
          setPendingDependents({ action: 'disable', skill, dependents })
          return
        }
      }
      await setEnabled(id, next)
      // Disabling a pinned skill auto-unpins it: a disabled skill can't be
      // summoned from the chat pinned bar, so keeping it in a pin slot wastes
      // one of the 10 available. The row animates from PINNED into DISABLED.
      // Re-enabling does NOT auto-repin; the user pins again deliberately.
      if (!next && pinnedSet.has(id)) {
        await togglePin(id)
      }
    },
    [setEnabled, pinnedSet, togglePin, skills],
  )

  const performLeave = (action: { type: 'cancel' } | { type: 'select'; id: string }) => {
    if (action.type === 'select') {
      setActiveId(action.id)
    }
    setMode('detail')
    setResetSignal((n) => n + 1)
    setIsDirty(false)
    setNameError(null)
  }

  const requestLeave = (action: { type: 'cancel' } | { type: 'select'; id: string }) => {
    if ((mode === 'create' || mode === 'edit') && isDirty) {
      setPendingLeave(action)
    } else {
      performLeave(action)
    }
  }

  const onSelectSkill = (id: string) => {
    if (mode === 'detail') {
      setActiveId(id)
      setMobileView('panel')
    } else {
      requestLeave({ type: 'select', id })
    }
  }

  const onConfirmDiscard = () => {
    if (pendingLeave) {
      performLeave(pendingLeave)
      setPendingLeave(null)
    }
  }

  const onEdit = (id: string) => {
    setActiveId(id)
    setMode('edit')
    setNameError(null)
    setMobileView('panel')
  }

  const onDelete = (id: string) => {
    const target = skills.find((s) => s.id === id)
    if (!target) {
      return
    }
    setActiveId(id)
    const dependents = findDependents(target.name ?? '', skills)
    if (dependents.length > 0) {
      setPendingDependents({ action: 'delete', skill: target, dependents })
    } else {
      // Snapshot the target skill so a concurrent sync that mutates `skills`
      // between open and confirm can't redirect the delete to a different row.
      setPendingDelete(target)
    }
  }

  const removeSkill = useCallback(
    async (id: string) => {
      await softDeleteSkill(id)
      if (pinnedSet.has(id)) {
        await togglePin(id)
      }
    },
    [softDeleteSkill, pinnedSet, togglePin],
  )

  const confirmPendingDependents = async () => {
    if (!pendingDependents) {
      return
    }
    const { action, skill } = pendingDependents
    setPendingDependents(null)
    if (action === 'disable') {
      await setEnabled(skill.id, false)
      if (pinnedSet.has(skill.id)) {
        await togglePin(skill.id)
      }
    } else {
      await removeSkill(skill.id)
    }
  }

  const onJumpToDependent = (id: string) => {
    setActiveId(id)
    setMode('edit')
    setPendingDependents(null)
  }

  const handleSubmit = async (values: SkillFormValues) => {
    try {
      if (mode === 'create') {
        const created = await createSkill(values)
        setActiveId(created.id)
      } else if (active) {
        await updateSkill({ id: active.id, patch: values })
        setActiveId(active.id)
      }
      setMode('detail')
      setIsDirty(false)
      setResetSignal((n) => n + 1)
      setNameError(null)
    } catch (error) {
      if (error instanceof SkillNameTakenError || error instanceof SkillNameInvalidError) {
        setNameError(error.message)
        return
      }
      throw error
    }
  }

  // Empty-state panel — most users never see this once seeded defaults land,
  // but it's the "I deleted everything" path. Stays inside the master/detail
  // layout so the list (and its + button) keep their normal position.
  const emptyPanel = (
    <section className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <h2 className="text-xl">No skill selected</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Skills are reusable instruction templates you can summon with a slash command.
        {skills.length === 0 ? ' Create one to get started.' : ' Select a skill from the list to view or edit it.'}
      </p>
    </section>
  )

  const createForm = (
    <SkillForm
      key="create"
      mode="create"
      onCancel={() => {
        requestLeave({ type: 'cancel' })
        if (isMobile) {
          setMobileView('list')
        }
      }}
      onSubmit={handleSubmit}
      onDirtyChange={setIsDirty}
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
        name={active.name ?? ''}
        description={active.description ?? ''}
        instruction={active.instruction ?? ''}
        pinned={pinnedSet.has(active.id)}
        enabled={isEnabled(active.id)}
        pinError={pinError}
        onTogglePin={() => tryTogglePin(active.id)}
        onToggleEnabled={(next) => handleToggleEnabled(active.id, next)}
        onEdit={() => onEdit(active.id)}
        onDelete={() => onDelete(active.id)}
        onBack={isMobile ? () => setMobileView('list') : undefined}
      />
    ) : (
      <SkillForm
        key={`edit:${active.id}`}
        mode="edit"
        initialValues={{
          name: active.name ?? '',
          description: active.description ?? '',
          instruction: active.instruction ?? '',
        }}
        onCancel={() => {
          requestLeave({ type: 'cancel' })
          if (isMobile) {
            setMobileView('list')
          }
        }}
        onSubmit={handleSubmit}
        onDirtyChange={setIsDirty}
        resetSignal={resetSignal}
        nameError={nameError}
      />
    )

  return (
    <div className="relative flex h-full">
      <SkillsList
        skills={skills}
        pinned={pinned}
        activeSkillId={mode === 'detail' && active ? active.id : null}
        isEnabled={isEnabled}
        isPinned={isPinned}
        onToggleEnabled={handleToggleEnabled}
        onTogglePin={tryTogglePin}
        onReorderPins={reorderPins}
        onCreate={() => {
          if ((mode === 'create' || mode === 'edit') && isDirty) {
            return
          }
          setMode('create')
          setNameError(null)
          setMobileView('panel')
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
              setPendingDependents(null)
            }
          }}
          action={pendingDependents.action}
          targetName={pendingDependents.skill.name ?? ''}
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
              setPendingDelete(null)
            }
          }}
          onConfirm={() => {
            void removeSkill(pendingDelete.id)
            setPendingDelete(null)
          }}
          skillName={pendingDelete.name ?? ''}
        />
      )}
      <DiscardCreateDialog
        open={pendingLeave !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingLeave(null)
          }
        }}
        onConfirm={onConfirmDiscard}
        title={mode === 'edit' ? 'Leave without saving?' : 'Leave without creating?'}
        description={mode === 'edit' ? "Your changes won't be saved." : "You'll lose what you've added so far."}
      />
    </div>
  )
}
