/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useState } from 'react'

import { useIsMobile } from '@/hooks/use-mobile'
import { DeleteSkillDialog } from './delete-skill-dialog'
import { DependentsDialog, type DependentsAction } from './dependents-dialog'
import { DiscardCreateDialog } from './discard-create-dialog'
import { findDependents } from './find-dependents'
import { SkillDetail } from './skill-detail'
import { SkillForm } from './skill-form'
import { SkillsList } from './skills-list'
import type { Skill } from './skills-data'
import { useEnabledSkills, useLibrarySkills, usePinnedSkills, useRecentSkills } from './use-skills-placeholder'

type Mode = 'detail' | 'create' | 'edit'

type PendingLeave = { type: 'cancel' } | { type: 'select'; name: string } | null

export const SkillsView = () => {
  const { isMobile } = useIsMobile()
  // Mobile: master/detail stack. Default view is the list; selecting a skill
  // or creating one flips to the panel (detail/form). The back button on the
  // panel returns to the list. Desktop ignores this flag and always shows both.
  const [mobileView, setMobileView] = useState<'list' | 'panel'>('list')
  const [mode, setMode] = useState<Mode>('detail')
  const [activeName, setActiveName] = useState('/meeting-notes')
  const [isDirty, setIsDirty] = useState(false)
  const [resetSignal, setResetSignal] = useState(0)
  const [pendingLeave, setPendingLeave] = useState<PendingLeave>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pendingDependents, setPendingDependents] = useState<{
    action: DependentsAction
    name: string
    dependents: Skill[]
  } | null>(null)
  const { pinnedSet, togglePin } = usePinnedSkills()
  const { isEnabled, setEnabled } = useEnabledSkills()
  const { recent, recordUsed } = useRecentSkills()
  const { skills, addLocalSkill, updateLocalSkill, markDeleted } = useLibrarySkills()
  const active = skills.find((s) => s.name === activeName) ?? skills[0]

  const handleToggleEnabled = useCallback(
    (name: string, next: boolean) => {
      if (!next) {
        const deps = findDependents(name, skills)
        if (deps.length > 0) {
          setPendingDependents({ action: 'disable', name, dependents: deps })
          return
        }
      }
      setEnabled(name, next)
      if (!next && pinnedSet.has(name)) {
        togglePin(name)
      }
    },
    [setEnabled, pinnedSet, togglePin, skills],
  )

  const isValidSkillRef = useCallback(
    (token: string) => skills.some((s) => s.name === token) && isEnabled(token),
    [skills, isEnabled],
  )

  const performLeave = (action: { type: 'cancel' } | { type: 'select'; name: string }) => {
    if (action.type === 'select') {
      setActiveName(action.name)
    }
    setMode('detail')
    setResetSignal((n) => n + 1)
    setIsDirty(false)
  }

  const requestLeave = (action: { type: 'cancel' } | { type: 'select'; name: string }) => {
    if ((mode === 'create' || mode === 'edit') && isDirty) {
      setPendingLeave(action)
    } else {
      performLeave(action)
    }
  }

  const handleDirtyChange = useCallback((d: boolean) => setIsDirty(d), [])

  const onSelectSkill = (name: string) => {
    if (mode === 'detail') {
      setActiveName(name)
      setMobileView('panel')
    } else {
      requestLeave({ type: 'select', name })
    }
  }

  const backToList = () => setMobileView('list')

  const onCancelForm = () => requestLeave({ type: 'cancel' })

  const onConfirmDiscard = () => {
    if (pendingLeave) {
      performLeave(pendingLeave)
      setPendingLeave(null)
    }
  }

  const onEdit = (name?: string) => {
    if (name) {
      setActiveName(name)
    }
    setMode('edit')
    setMobileView('panel')
  }

  const onDelete = (name?: string) => {
    const targetName = name ?? active?.name
    if (!targetName) {
      return
    }
    if (name) {
      setActiveName(name)
    }
    const target = skills.find((s) => s.name === targetName)
    const deps = findDependents(targetName, skills)
    if (deps.length > 0) {
      setPendingDependents({
        action: target?.source === 'marketplace' ? 'uninstall' : 'delete',
        name: targetName,
        dependents: deps,
      })
    } else {
      setDeleteOpen(true)
    }
  }

  const removeSkill = useCallback(
    (name: string) => {
      markDeleted(name)
      if (pinnedSet.has(name)) {
        togglePin(name)
      }
      if (!isEnabled(name)) {
        setEnabled(name, true)
      }
    },
    [markDeleted, pinnedSet, togglePin, isEnabled, setEnabled],
  )

  const confirmPendingDependents = () => {
    if (!pendingDependents) {
      return
    }
    const { action, name } = pendingDependents
    if (action === 'disable') {
      setEnabled(name, false)
      if (pinnedSet.has(name)) {
        togglePin(name)
      }
    } else {
      removeSkill(name)
    }
    setPendingDependents(null)
  }

  const onJumpToDependent = (depName: string) => {
    setActiveName(depName)
    const dep = skills.find((s) => s.name === depName)
    setMode(dep?.source === 'local' ? 'edit' : 'detail')
    setPendingDependents(null)
  }

  if (!active) {
    return null
  }

  // Desktop shows list + panel side-by-side. Mobile keeps the list as the base
  // layer and slides the panel in from the right when a skill is selected.
  const panel =
    mode === 'detail' ? (
      <SkillDetail
        name={active.name}
        source={active.source}
        pinned={pinnedSet.has(active.name)}
        enabled={isEnabled(active.name)}
        version={active.version}
        description={active.description}
        instruction={active.instruction}
        onTogglePin={() => togglePin(active.name)}
        onToggleEnabled={(next) => handleToggleEnabled(active.name, next)}
        onEdit={onEdit}
        onDelete={onDelete}
        onBack={isMobile ? backToList : undefined}
        isValidSkillRef={isValidSkillRef}
      />
    ) : (
      <SkillForm
        key={mode === 'edit' ? `edit:${active.name}` : 'create'}
        mode={mode === 'edit' ? 'edit' : 'create'}
        initialValues={
          mode === 'edit'
            ? {
                name: active.name,
                description: active.description,
                instruction: active.instruction,
              }
            : undefined
        }
        onCancel={() => {
          onCancelForm()
          if (isMobile) {
            setMobileView('list')
          }
        }}
        isValidSkillRef={isValidSkillRef}
        library={skills}
        isEnabled={isEnabled}
        recent={recent}
        onRecordSkillUsed={recordUsed}
        onSubmit={(values) => {
          if (mode === 'create') {
            addLocalSkill(values)
          } else {
            updateLocalSkill(active.name, values)
          }
          setActiveName(values.name)
          setMode('detail')
          setIsDirty(false)
          setResetSignal((n) => n + 1)
        }}
        onDirtyChange={handleDirtyChange}
        resetSignal={resetSignal}
      />
    )

  return (
    <div className="relative flex h-full">
      <SkillsList
        skills={skills}
        activeSkill={mode === 'detail' ? active.name : ''}
        activeSource={active.source}
        isEnabled={isEnabled}
        onToggleEnabled={handleToggleEnabled}
        onCreate={() => {
          if ((mode === 'create' || mode === 'edit') && isDirty) {
            return
          }
          setMode('create')
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
            <motion.div
              key="mobile-panel"
              className="absolute inset-0 z-10 flex bg-background"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 35, stiffness: 400, mass: 0.8 }}
            >
              {panel}
            </motion.div>
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
          targetName={pendingDependents.name}
          dependents={pendingDependents.dependents}
          onConfirm={confirmPendingDependents}
          onJumpToDependent={onJumpToDependent}
        />
      )}
      <DeleteSkillDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          removeSkill(active.name)
          setDeleteOpen(false)
        }}
        action={active.source === 'local' ? 'delete' : 'uninstall'}
        skillName={active.name}
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
