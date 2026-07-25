/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'

import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import { SkillForm, type SkillFormValues } from '@/skills/skill-form'
import {
  handleSkillSaveError,
  skillCreateInitialValues,
  skillSaveFailedMessage,
  useCreateSkillTracked,
} from '@/skills/skill-save'
import { CreateItemPanelShell } from './create-item-panel-shell'

type CreateSkillState = {
  isDirty: boolean
  isDiscardOpen: boolean
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
  isDiscardOpen: false,
  slugError: null,
  submitError: null,
}

/** Reduces the create-only skill form's dirty, discard, and error states. */
const createSkillReducer = (state: CreateSkillState, action: CreateSkillAction): CreateSkillState => {
  switch (action.type) {
    case 'DIRTY_CHANGED':
      return { ...state, isDirty: action.dirty }
    case 'DISCARD_OPENED':
      return { ...state, isDiscardOpen: true }
    case 'DISCARD_CLOSED':
      return { ...state, isDiscardOpen: false }
    case 'SLUG_CHANGED':
      return { ...state, slugError: null }
    case 'SLUG_REJECTED':
      return { ...state, slugError: action.message, submitError: null }
    case 'SUBMIT_FAILED':
      return { ...state, submitError: skillSaveFailedMessage }
  }
}

type CreateSkillPanelProps = {
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
  initialName?: string
}

/** Creates a skill over the current screen without changing routes. */
export const CreateSkillPanel = ({ open, onClose, onCloseComplete, initialName }: CreateSkillPanelProps) => {
  const createSkillTracked = useCreateSkillTracked()
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
      await createSkillTracked(values)
      onClose()
    } catch (error) {
      handleSkillSaveError(error, {
        onSlugRejected: (message) => dispatch({ type: 'SLUG_REJECTED', message }),
        onFailed: () => dispatch({ type: 'SUBMIT_FAILED' }),
      })
    }
  }

  const initialValues = skillCreateInitialValues(initialName)

  return (
    <>
      <CreateItemPanelShell kind="skill" open={open} onClose={requestClose} onCloseComplete={onCloseComplete}>
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
      </CreateItemPanelShell>
      <DiscardCreateDialog
        open={state.isDiscardOpen}
        onOpenChange={(nextOpen) => !nextOpen && dispatch({ type: 'DISCARD_CLOSED' })}
        onConfirm={() => {
          dispatch({ type: 'DISCARD_CLOSED' })
          onClose()
        }}
      />
    </>
  )
}
