/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'

import { DetailPanel } from '@/components/detail-panel'
import { SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import { titleCaseFromSlug } from '@/skills/display'
import { SkillForm, type SkillFormValues } from '@/skills/skill-form'
import { useSkillTelemetry } from '@/skills/telemetry'
import { useLibrarySkills } from '@/skills/use-skills'
import { CreateItemSurface } from './create-item-surface'

type CreateSkillState = {
  isDirty: boolean
  discardOpen: boolean
  slugError: string | null
  submitError: string | null
}

type CreateSkillAction =
  | { type: 'DIRTY_CHANGED'; dirty: boolean }
  | { type: 'DISCARD_OPENED' }
  | { type: 'DISCARD_CLOSED' }
  | { type: 'SLUG_CHANGED' }
  | { type: 'SLUG_REJECTED'; message: string }
  | { type: 'SUBMIT_FAILED' }

const initialState: CreateSkillState = {
  isDirty: false,
  discardOpen: false,
  slugError: null,
  submitError: null,
}

/** Reduces the create-only skill form's dirty, discard, and error states. */
const createSkillReducer = (state: CreateSkillState, action: CreateSkillAction): CreateSkillState => {
  switch (action.type) {
    case 'DIRTY_CHANGED':
      return { ...state, isDirty: action.dirty }
    case 'DISCARD_OPENED':
      return { ...state, discardOpen: true }
    case 'DISCARD_CLOSED':
      return { ...state, discardOpen: false }
    case 'SLUG_CHANGED':
      return { ...state, slugError: null }
    case 'SLUG_REJECTED':
      return { ...state, slugError: action.message, submitError: null }
    case 'SUBMIT_FAILED':
      return { ...state, submitError: "Couldn't save the skill. Please try again." }
  }
}

type CreateSkillPanelProps = {
  open: boolean
  onClose: () => void
  initialName?: string
}

/** Creates a skill over the current screen without changing routes. */
export const CreateSkillPanel = ({ open, onClose, initialName }: CreateSkillPanelProps) => {
  const { createSkill } = useLibrarySkills()
  const trackSkillEvent = useSkillTelemetry()
  const [state, dispatch] = useReducer(createSkillReducer, initialState)

  const requestClose = () => {
    if (state.isDirty) {
      dispatch({ type: 'DISCARD_OPENED' })
      return
    }
    onClose()
  }

  const handleSubmit = async (values: SkillFormValues) => {
    try {
      const created = await createSkill(values)
      trackSkillEvent('skill_created', created.id, { instruction_length: values.instruction.length })
      onClose()
    } catch (error) {
      if (error instanceof SkillNameTakenError || error instanceof SkillNameInvalidError) {
        dispatch({ type: 'SLUG_REJECTED', message: error.message })
        return
      }
      console.error('Failed to save skill', error)
      dispatch({ type: 'SUBMIT_FAILED' })
    }
  }

  const initialValues = initialName
    ? {
        name: initialName,
        label: titleCaseFromSlug(initialName),
        description: '',
        instruction: '',
      }
    : undefined

  return (
    <>
      <CreateItemSurface open={open} onClose={requestClose}>
        <DetailPanel title="Create Skill" onClose={requestClose}>
          <SkillForm
            mode="create"
            initialValues={initialValues}
            onCancel={requestClose}
            onSubmit={handleSubmit}
            onDirtyChange={(dirty) => dispatch({ type: 'DIRTY_CHANGED', dirty })}
            onSlugChange={() => dispatch({ type: 'SLUG_CHANGED' })}
            slugError={state.slugError}
            submitError={state.submitError}
          />
        </DetailPanel>
      </CreateItemSurface>
      <DiscardCreateDialog
        open={state.discardOpen}
        onOpenChange={(nextOpen) => !nextOpen && dispatch({ type: 'DISCARD_CLOSED' })}
        onConfirm={() => {
          dispatch({ type: 'DISCARD_CLOSED' })
          onClose()
        }}
      />
    </>
  )
}
