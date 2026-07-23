/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { validateSkillName } from '@/dal'
import { useSkillFormState, type SkillFormMode, type SkillFormValues } from './use-skill-form-state'

export type { SkillFormMode, SkillFormValues }

/**
 * Plain-text create/edit form. The user types a free-text Name; the slug
 * auto-generates from it until the user edits the slug directly (clearing the
 * slug hands control back to auto-generation). Edit mode never auto-rewrites
 * the slug — renaming an existing skill must not silently break `/tokens`
 * already used in chats.
 *
 * Renders as plain panel content — the skills view hosts it inside the shared
 * DetailPanel, which owns the "Create Skill"/"Edit Skill" header and the
 * close affordance (close behaves as Cancel, including the dirty guard).
 */
export const SkillForm = ({
  onCancel,
  onSubmit,
  onDirtyChange,
  onSlugChange,
  resetSignal,
  mode = 'create',
  initialValues,
  slugError,
  submitError,
}: {
  onCancel: () => void
  /** May be async; the parent owns failure handling (it reports errors back
   *  via `slugError`/`submitError` and never lets the promise reject). */
  onSubmit: (values: SkillFormValues) => void | Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  /** Fires whenever the user edits the slug (directly or via auto-generation).
   *  Used to clear stale parent-side uniqueness errors so they don't persist
   *  past the edit that invalidates them. */
  onSlugChange?: () => void
  /** Increment to force the form to reset back to {@link initialValues}. */
  resetSignal?: number
  mode?: SkillFormMode
  initialValues?: SkillFormValues
  /** Inline slug-uniqueness error from the DAL pre-check. */
  slugError?: string | null
  /** Generic save-failure message shown next to the submit button. */
  submitError?: string | null
}) => {
  const {
    label,
    slug,
    description,
    instruction,
    isDirty,
    handleLabelChange,
    handleSlugChange,
    handleDescriptionChange,
    handleInstructionChange,
  } = useSkillFormState({ mode, initialValues, resetSignal, onDirtyChange, onSlugChange })

  // Auto-focus the name input on mount for `create` mode — the user just
  // clicked "+", they're about to type a name. Edit mode skips this so we
  // don't steal focus from a user who clicked into a specific skill to
  // change one field.
  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (mode === 'create') {
      nameInputRef.current?.focus()
    }
  }, [mode])

  // Surface AgentSkills-spec violations inline as soon as the user has typed
  // something, but don't shout at an empty initial state. Validate against the
  // trimmed value — `handleSubmit` submits the trimmed slug, so the two must
  // agree.
  const trimmedSlug = slug.trim()
  const localSlugError = trimmedSlug === '' ? null : validateSkillName(trimmedSlug)
  // Block submission while a server-side slug error (e.g. SkillNameTakenError)
  // is still showing — slug edits clear it, so the button re-enables on the
  // next keystroke.
  const canSubmit =
    label.trim() !== '' &&
    trimmedSlug !== '' &&
    description.trim() !== '' &&
    instruction.trim() !== '' &&
    localSlugError === null &&
    !slugError
  const canSave = canSubmit && (mode === 'create' || isDirty)

  const handleSubmit = () => {
    if (!canSave) {
      return
    }
    void onSubmit({
      name: trimmedSlug,
      label: label.trim(),
      description: description.trim(),
      instruction: instruction.trim(),
    })
  }

  return (
    // No background of its own: inherits the hosting detail panel's surface.
    <section className="flex min-h-full flex-col text-foreground md:h-full md:min-h-0 md:flex-1">
      <div className="flex flex-col gap-5 md:min-h-0 md:flex-1">
        <div className="flex flex-col gap-2">
          <label htmlFor="skill-label" className="text-base text-foreground">
            Name
          </label>
          <Input
            id="skill-label"
            ref={nameInputRef}
            placeholder="Daily Brief"
            value={label}
            onChange={(e) => handleLabelChange(e.target.value)}
            className="md:h-9"
          />
          <div className="mt-1 flex flex-col gap-2">
            <label htmlFor="skill-slug" className="text-base text-foreground">
              Slug
            </label>
            <Input
              id="skill-slug"
              placeholder="daily-brief"
              value={slug}
              onChange={(event) => handleSlugChange(event.target.value)}
              aria-invalid={localSlugError || slugError ? true : undefined}
              className="md:h-9"
            />
            {(localSlugError ?? slugError) && <p className="text-sm text-destructive">{localSlugError ?? slugError}</p>}
          </div>
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
            placeholder="When to use this skill…"
            value={description}
            onChange={(e) => handleDescriptionChange(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2 md:min-h-0 md:flex-1">
          <label htmlFor="skill-instruction" className="text-base text-foreground">
            Instructions
          </label>
          <Textarea
            id="skill-instruction"
            placeholder="What the assistant should do…"
            value={instruction}
            onChange={(e) => handleInstructionChange(e.target.value)}
            className="min-h-48 resize-y md:min-h-0 md:flex-1 md:resize-none"
          />
        </div>
      </div>

      <FormFooter>
        {submitError && (
          <p role="alert" className="min-w-0 flex-1 truncate text-sm text-destructive">
            {submitError}
          </p>
        )}
        <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
        <Button disabled={!canSave} onClick={handleSubmit}>
          {mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </FormFooter>
    </section>
  )
}
