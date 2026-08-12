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

import { useState } from 'react'

import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { useDatabase } from '@/contexts'
import { createProject, maxProjectInstructionsLength, maxProjectNameLength } from '@/dal/projects'

type CreateProjectPanelProps = {
  onClose: () => void
  onCreated: (projectId: string) => void
}

export const CreateProjectPanel = ({ onClose, onCreated }: CreateProjectPanelProps) => {
  const db = useDatabase()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [isPending, setIsPending] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const canSave = name.trim().length > 0 && !isPending

  const handleSubmit = async () => {
    setIsPending(true)
    setSubmitError(null)
    try {
      const project = await createProject(db, {
        name,
        description: description.trim() || null,
        instructions: instructions.trim() || null,
      })
      onCreated(project.id)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not create the project.')
      setIsPending(false)
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
            onChange={(event) => setName(event.target.value)}
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
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor="new-project-instructions">
            Instructions
          </label>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            Applied to every chat in this project. You can add reference documents once it exists.
          </p>
          <Textarea
            id="new-project-instructions"
            maxLength={maxProjectInstructionsLength}
            placeholder="Reply in British English. Prefer bullet points over prose."
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
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
