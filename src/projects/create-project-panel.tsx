/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The "New project" slide-out, mirroring Create Skill: a `DetailPanel` inside the
 * list page's `DetailPanelSurface`, with the panel's close X acting as Cancel.
 *
 * Knowledge documents are deliberately NOT collected here. A project is useful
 * the moment it has a name, and uploads need somewhere to attach to — so create
 * is name + instructions, and documents are added on the detail page.
 */

import { useReducer } from 'react'

import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { useDatabase } from '@/contexts'
import { createProject, maxProjectInstructionsLength, maxProjectNameLength } from '@/dal/projects'

type CreateProjectState = {
  name: string
  description: string
  instructions: string
  isPending: boolean
  submitError: string | null
}

type CreateProjectAction =
  | { type: 'FIELD_CHANGED'; field: 'name' | 'description' | 'instructions'; value: string }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_FAILED'; message: string }

const initialState: CreateProjectState = {
  name: '',
  description: '',
  instructions: '',
  isPending: false,
  submitError: null,
}

const createProjectReducer = (state: CreateProjectState, action: CreateProjectAction): CreateProjectState => {
  switch (action.type) {
    case 'FIELD_CHANGED':
      // Clearing the error on edit means a failed submit doesn't keep shouting
      // while the user fixes the thing it complained about.
      return { ...state, [action.field]: action.value, submitError: null }
    case 'SUBMIT_STARTED':
      return { ...state, isPending: true, submitError: null }
    case 'SUBMIT_FAILED':
      return { ...state, isPending: false, submitError: action.message }
  }
}

type CreateProjectPanelProps = {
  onClose: () => void
  onCreated: (projectId: string) => void
}

export const CreateProjectPanel = ({ onClose, onCreated }: CreateProjectPanelProps) => {
  const db = useDatabase()
  const [{ name, description, instructions, isPending, submitError }, dispatch] = useReducer(
    createProjectReducer,
    initialState,
  )

  const canSave = name.trim().length > 0 && !isPending

  const handleSubmit = async () => {
    dispatch({ type: 'SUBMIT_STARTED' })
    try {
      const project = await createProject(db, {
        name,
        description: description.trim() || null,
        instructions: instructions.trim() || null,
      })
      onCreated(project.id)
    } catch (error) {
      dispatch({
        type: 'SUBMIT_FAILED',
        message: error instanceof Error ? error.message : 'Could not create the project.',
      })
    }
  }

  return (
    <DetailPanel title="Create project" onClose={onClose}>
      <section className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor="new-project-name">
            Name
          </label>
          <Input
            id="new-project-name"
            autoFocus
            maxLength={maxProjectNameLength}
            placeholder="Q3 planning"
            value={name}
            onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'name', value: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor="new-project-description">
            Description
          </label>
          <Input
            id="new-project-description"
            placeholder="Optional — what this project is for"
            value={description}
            onChange={(event) => dispatch({ type: 'FIELD_CHANGED', field: 'description', value: event.target.value })}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor="new-project-instructions">
            Instructions
          </label>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {/* Documents have one door — attaching a file in a chat. Promising an
                uploader here was wrong once the project-side one was removed. */}
            Applied to every chat in this project. Reference documents join it by being attached in one of its chats.
          </p>
          <Textarea
            id="new-project-instructions"
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
          <ResponsiveModalCancel onClick={onClose} className="dark:hover:bg-accent" />
          <Button isLoading={isPending} loadingLabel="Creating…" disabled={!canSave} onClick={handleSubmit}>
            Create
          </Button>
        </FormFooter>
      </section>
    </DetailPanel>
  )
}
