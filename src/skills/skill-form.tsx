/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type SkillFormMode = 'create' | 'edit'

export type SkillFormValues = {
  name: string
  description: string
  instruction: string
}

/**
 * Plain-text create/edit form. Slash-token autocomplete and in-editor
 * highlighting land in THU-535 alongside the chat-side slash UX — keeping the
 * editor and chat input on a single shared component.
 */
export const SkillForm = ({
  onCancel,
  onSubmit,
  onDirtyChange,
  resetSignal,
  mode = 'create',
  initialValues,
  nameError,
}: {
  onCancel: () => void
  onSubmit: (values: SkillFormValues) => void
  onDirtyChange?: (dirty: boolean) => void
  /** Increment to force the form to reset back to {@link initialValues}. */
  resetSignal?: number
  mode?: SkillFormMode
  initialValues?: SkillFormValues
  /** Inline name-uniqueness error from the DAL pre-check. */
  nameError?: string | null
}) => {
  const initialName = initialValues?.name ?? ''
  const initialDescription = initialValues?.description ?? ''
  const initialInstruction = initialValues?.instruction ?? ''

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [instruction, setInstruction] = useState(initialInstruction)

  const canSubmit = name.trim() !== '' && description.trim() !== '' && instruction.trim() !== ''

  const isDirty =
    mode === 'edit'
      ? name !== initialName || description !== initialDescription || instruction !== initialInstruction
      : name.length > 0 || description.length > 0 || instruction.length > 0

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const [prevResetSignal, setPrevResetSignal] = useState(resetSignal)
  if (resetSignal !== undefined && prevResetSignal !== resetSignal) {
    setPrevResetSignal(resetSignal)
    setName(initialName)
    setDescription(initialDescription)
    setInstruction(initialInstruction)
  }

  const handleSubmit = () => {
    if (!canSubmit) {
      return
    }
    const trimmedName = name.trim()
    const finalName = trimmedName.startsWith('/') ? trimmedName : `/${trimmedName}`
    onSubmit({
      name: finalName,
      description: description.trim(),
      instruction: instruction.trim(),
    })
  }

  return (
    <section className="flex h-full flex-1 flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
        <h2 className="text-xl text-foreground">{mode === 'edit' ? 'Edit Skill' : 'Create Skill'}</h2>

        <div className="flex flex-col gap-2">
          <label htmlFor="skill-name" className="text-base text-foreground">
            Skill name
          </label>
          <Input
            id="skill-name"
            placeholder="meeting-notes"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9"
            aria-invalid={nameError ? true : undefined}
          />
          {nameError && <p className="text-sm text-destructive">{nameError}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="skill-description" className="flex items-center gap-1.5 text-base text-foreground">
            Description
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="What is this for?"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Info size={14} strokeWidth={1.75} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[202px]">
                Helps the agent decide when to use this skill. Be specific about when it applies.
              </TooltipContent>
            </Tooltip>
          </label>
          <Textarea
            id="skill-description"
            rows={3}
            placeholder="Use when the user shares raw meeting notes or a transcript and wants it cleaned up, summarized, or turned into action items."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label htmlFor="skill-instruction" className="text-base text-foreground">
            Instructions
          </label>
          <Textarea
            id="skill-instruction"
            placeholder={`Pull out three things from the notes: decisions made, action items (who does what by when), and open questions.\n\nDon't add a summary paragraph – just the lists. Then ask if they want help sending it to anyone.`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className="min-h-0 flex-1 resize-none"
          />
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 px-6 py-4">
        <Button variant="outline" size="lg" onClick={onCancel} className="text-sm">
          Cancel
        </Button>
        <Button variant="default" size="lg" disabled={!canSubmit} className="text-sm" onClick={handleSubmit}>
          {mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </footer>
    </section>
  )
}
