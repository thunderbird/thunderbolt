/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { validateSkillName } from '@/dal'

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
  // Strip a leading `/` defensively — names are stored bare per the
  // AgentSkills spec, but legacy rows from before THU-534 landed may still
  // carry the prefix and we don't want the editor to show `//foo`.
  const initialName = (initialValues?.name ?? '').replace(/^\/+/, '')
  const initialDescription = initialValues?.description ?? ''
  const initialInstruction = initialValues?.instruction ?? ''

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [instruction, setInstruction] = useState(initialInstruction)

  // Surface AgentSkills-spec violations inline as soon as the user has typed
  // something, but don't shout at an empty initial state.
  const localNameError = name.trim() === '' ? null : validateSkillName(name)
  const canSubmit =
    name.trim() !== '' && description.trim() !== '' && instruction.trim() !== '' && localNameError === null

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
    onSubmit({
      name: name.trim(),
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
          <div className="relative">
            {/* Stripe-style fixed `/` prefix. Sits inside the input visually
                but is not part of the value — the user can't select, delete,
                or edit it. Stored names are bare slugs per the AgentSkills
                spec; the slash is the chat trigger added at display time. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-muted-foreground"
            >
              /
            </span>
            <Input
              id="skill-name"
              placeholder="meeting-notes"
              value={name}
              // Strip any pasted leading `/` so the value mirrors what
              // appears after the prefix glyph.
              onChange={(e) => setName(e.target.value.replace(/^\/+/, ''))}
              className="h-9 pl-7"
              aria-describedby="skill-name-help"
              aria-invalid={localNameError || nameError ? true : undefined}
            />
          </div>
          {localNameError || nameError ? (
            <p className="text-sm text-destructive">{localNameError ?? nameError}</p>
          ) : (
            <p id="skill-name-help" className="text-sm text-muted-foreground">
              Lowercase letters, numbers, and hyphens. 1–64 characters.
            </p>
          )}
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
