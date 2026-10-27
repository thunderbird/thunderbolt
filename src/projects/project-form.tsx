/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Edit a project's emoji, name, description, and shared instructions.
 * The host owns the panel header and close affordance (close behaves as Cancel).
 */

import { Trans, useLingui } from '@lingui/react/macro'
import { useReducer } from 'react'

import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { maxProjectInstructionsLength, maxProjectNameLength } from '@/dal/projects'
import { EmojiPicker } from './emoji-picker'

export type ProjectFormValues = {
  icon: string | null
  name: string
  description: string
  instructions: string
}

type ProjectFormState = ProjectFormValues & { isPending: boolean; submitError: string | null }

type ProjectFormAction =
  | { type: 'FIELD_CHANGED'; field: 'name' | 'description' | 'instructions'; value: string }
  | { type: 'ICON_CHANGED'; icon: string | null }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_FAILED'; message: string }

const projectFormReducer = (state: ProjectFormState, action: ProjectFormAction): ProjectFormState => {
  switch (action.type) {
    case 'FIELD_CHANGED':
      // Clearing the error on edit means a failed submit doesn't keep shouting
      // while the user fixes the thing it complained about.
      return { ...state, [action.field]: action.value, submitError: null }
    case 'ICON_CHANGED':
      return { ...state, icon: action.icon, submitError: null }
    case 'SUBMIT_STARTED':
      return { ...state, isPending: true, submitError: null }
    case 'SUBMIT_FAILED':
      return { ...state, isPending: false, submitError: action.message }
  }
}

type ProjectFormProps = {
  initialValues: ProjectFormValues
  onCancel: () => void
  /** May reject; the form catches and shows the message rather than letting the
   *  rejection escape a handler React does not await. */
  onSubmit: (values: ProjectFormValues) => Promise<void>
}

export const ProjectForm = ({ initialValues, onCancel, onSubmit }: ProjectFormProps) => {
  const { t } = useLingui()
  const [{ icon, name, description, instructions, isPending, submitError }, dispatch] = useReducer(projectFormReducer, {
    ...initialValues,
    isPending: false,
    submitError: null,
  })

  const canSave = name.trim().length > 0 && !isPending

  const handleSubmit = async () => {
    dispatch({ type: 'SUBMIT_STARTED' })
    try {
      await onSubmit({ icon, name, description, instructions })
    } catch (error) {
      const fallback = t`Could not save the project.`
      dispatch({ type: 'SUBMIT_FAILED', message: error instanceof Error ? error.message : fallback })
    }
  }

  const fieldId = (field: string) => `edit-project-${field}`

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor={fieldId('name')}>
          <Trans>Name</Trans>
        </label>
        <EmojiPicker
          value={icon}
          label={name || t`this project`}
          onChange={(next) => dispatch({ type: 'ICON_CHANGED', icon: next })}
        >
          <Input
            id={fieldId('name')}
            maxLength={maxProjectNameLength}
            placeholder={t`Q3 planning`}
            value={name}
            onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'name', value: event.target.value })}
            className="flex-1"
          />
        </EmojiPicker>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor={fieldId('description')}>
          <Trans>Description (optional)</Trans>
        </label>
        <Input
          id={fieldId('description')}
          placeholder={t`What is this project for?`}
          value={description}
          onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'description', value: event.target.value })}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor={fieldId('instructions')}>
          <Trans>Instructions</Trans>
        </label>
        <Textarea
          id={fieldId('instructions')}
          maxLength={maxProjectInstructionsLength}
          placeholder={t`Shared instructions for projects chats`}
          value={instructions}
          onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'instructions', value: event.target.value })}
          className="min-h-48 resize-none md:min-h-48"
        />
      </div>

      <FormFooter>
        {submitError && (
          <p role="alert" className="min-w-0 flex-1 truncate text-sm text-destructive">
            {submitError}
          </p>
        )}
        <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
        <Button isLoading={isPending} loadingLabel={t`Saving…`} disabled={!canSave} onClick={handleSubmit}>
          <Trans>Save changes</Trans>
        </Button>
      </FormFooter>
    </section>
  )
}
