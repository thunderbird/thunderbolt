/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Create/edit form for a project: emoji, name, description, instructions.
 *
 * One form for both modes, mirroring `SkillForm` — the two used to be a panel and
 * a page with separately-written fields, which is how they drift. Renders as
 * plain panel content; the host owns the `DetailPanel` header and close
 * affordance (close behaves as Cancel).
 */

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

const emptyValues: ProjectFormValues = { icon: null, name: '', description: '', instructions: '' }

type ProjectFormProps = {
  mode: 'create' | 'edit'
  initialValues?: ProjectFormValues
  onCancel: () => void
  /** May reject; the form catches and shows the message rather than letting the
   *  rejection escape a handler React does not await. */
  onSubmit: (values: ProjectFormValues) => Promise<void>
}

export const ProjectForm = ({ mode, initialValues, onCancel, onSubmit }: ProjectFormProps) => {
  const [{ icon, name, description, instructions, isPending, submitError }, dispatch] = useReducer(projectFormReducer, {
    ...(initialValues ?? emptyValues),
    isPending: false,
    submitError: null,
  })

  const canSave = name.trim().length > 0 && !isPending

  const handleSubmit = async () => {
    dispatch({ type: 'SUBMIT_STARTED' })
    try {
      await onSubmit({ icon, name, description, instructions })
    } catch (error) {
      const fallback = mode === 'create' ? 'Could not create the project.' : 'Could not save the project.'
      dispatch({ type: 'SUBMIT_FAILED', message: error instanceof Error ? error.message : fallback })
    }
  }

  const fieldId = (field: string) => `${mode}-project-${field}`

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor={fieldId('name')}>
          Name
        </label>
        <div className="flex items-center gap-2">
          <EmojiPicker
            value={icon}
            label={name || 'this project'}
            onChange={(next) => dispatch({ type: 'ICON_CHANGED', icon: next })}
          />
          <Input
            id={fieldId('name')}
            autoFocus={mode === 'create'}
            maxLength={maxProjectNameLength}
            placeholder="Q3 planning"
            value={name}
            onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'name', value: event.target.value })}
            className="flex-1"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor={fieldId('description')}>
          Description
        </label>
        <Input
          id={fieldId('description')}
          placeholder="Optional — what this project is for"
          value={description}
          onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'description', value: event.target.value })}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor={fieldId('instructions')}>
          Instructions
        </label>
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          Applied to every chat in this project.
        </p>
        <Textarea
          id={fieldId('instructions')}
          maxLength={maxProjectInstructionsLength}
          placeholder="Reply in British English. Prefer bullet points over prose."
          value={instructions}
          onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'instructions', value: event.target.value })}
          className="min-h-32 resize-y md:min-h-0 md:flex-1 md:resize-none"
        />
      </div>

      <FormFooter>
        {submitError && (
          <p role="alert" className="min-w-0 flex-1 truncate text-sm text-destructive">
            {submitError}
          </p>
        )}
        <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
        <Button
          isLoading={isPending}
          loadingLabel={mode === 'create' ? 'Creating…' : 'Saving…'}
          disabled={!canSave}
          onClick={handleSubmit}
        >
          {mode === 'create' ? 'Create' : 'Save changes'}
        </Button>
      </FormFooter>
    </section>
  )
}
