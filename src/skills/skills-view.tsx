/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useState } from 'react'

import { SkillNameTakenError } from '@/dal'
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

type Mode = 'detail' | 'create' | 'edit'

type PendingLeave = { type: 'cancel' } | { type: 'select'; id: string } | null

export const SkillsView = () => {
  const { isMobile } = useIsMobile()
  const { skills, createSkill, updateSkill, softDeleteSkill } = useLibrarySkills()
  const { pinnedSet, togglePin } = usePinnedSkills()
  const { isEnabled, setEnabled } = useEnabledSkills()

  // Mobile uses a master/detail stack — list at the base, panel slides in.
  // Desktop ignores `mobileView` and always renders both side-by-side.
  const [mobileView, setMobileView] = useState<'list' | 'panel'>('list')
  const [mode, setMode] = useState<Mode>('detail')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [resetSignal, setResetSignal] = useState(0)
  const [pendingLeave, setPendingLeave] = useState<PendingLeave>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pendingDependents, setPendingDependents] = useState<{
    action: DependentsAction
    skill: Skill
    dependents: Skill[]
  } | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  const active = skills.find((s) => s.id === activeId) ?? skills[0] ?? null

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
      setDeleteOpen(true)
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
      if (error instanceof SkillNameTakenError) {
        setNameError(error.message)
        return
      }
      throw error
    }
  }

  if (skills.length === 0) {
    // Empty state — the seeded starter set means most users never see this;
    // it's the "I deleted everything" path. Copy is intentionally minimal.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-foreground">
        <h2 className="text-xl">No skills yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Skills are reusable instruction templates you can summon with a slash command. Create one to get started.
        </p>
        <SkillsList
          skills={[]}
          activeSkillId={null}
          isEnabled={() => false}
          onToggleEnabled={() => {}}
          onCreate={() => {
            setMode('create')
            setMobileView('panel')
          }}
          onSelectSkill={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </div>
    )
  }

  if (!active) {
    return null
  }

  const panel =
    mode === 'detail' ? (
      <SkillDetail
        name={active.name ?? ''}
        description={active.description ?? ''}
        instruction={active.instruction ?? ''}
        pinned={pinnedSet.has(active.id)}
        enabled={isEnabled(active.id)}
        onTogglePin={() => togglePin(active.id)}
        onToggleEnabled={(next) => handleToggleEnabled(active.id, next)}
        onEdit={() => onEdit(active.id)}
        onDelete={() => onDelete(active.id)}
        onBack={isMobile ? () => setMobileView('list') : undefined}
      />
    ) : (
      <SkillForm
        key={mode === 'edit' ? `edit:${active.id}` : 'create'}
        mode={mode === 'edit' ? 'edit' : 'create'}
        initialValues={
          mode === 'edit'
            ? {
                name: active.name ?? '',
                description: active.description ?? '',
                instruction: active.instruction ?? '',
              }
            : undefined
        }
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
        activeSkillId={mode === 'detail' ? active.id : null}
        isEnabled={isEnabled}
        onToggleEnabled={handleToggleEnabled}
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
          open={pendingDependents !== null}
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
      <DeleteSkillDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          if (active) {
            void removeSkill(active.id)
          }
          setDeleteOpen(false)
        }}
        skillName={active.name ?? ''}
      />
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
