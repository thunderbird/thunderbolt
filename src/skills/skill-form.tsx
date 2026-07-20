/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { validateSkillName } from '@/dal'
import { cn } from '@/lib/utils'
import { useSkillFormState, type SkillFormMode, type SkillFormValues } from './use-skill-form-state'

export type { SkillFormMode, SkillFormValues }

/**
 * Plain-text create/edit form. The user types a free-text Name; the slug
 * auto-generates from it until the user edits the slug directly (clearing the
 * slug hands control back to auto-generation). Edit mode never auto-rewrites
 * the slug — renaming an existing skill must not silently break `/tokens`
 * already used in chats.
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

  const handleSubmit = () => {
    if (!canSubmit) {
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
    // No background of its own: inherits the desktop slide-in surface card
    // or the mobile overlay's background.
    <section className="relative flex h-full flex-1 flex-col text-foreground">
      {/* Same corner placement as the detail panel's close button (8px from
          top and right); behaves exactly like Cancel, including the
          unsaved-changes guard. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onCancel}
        aria-label="Close"
        className={cn('absolute right-2 top-2', mutedIconButtonClass)}
      >
        <X className="size-4" />
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
        <h2 className="text-xl text-foreground">{mode === 'edit' ? 'Edit skill' : 'Create skill'}</h2>

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
            className="h-9"
          />
          {/* De-emphasized slug row: most users never touch it — it fills
              itself in from the Name. Ghost styling (no border until
              hover/focus) keeps it from competing with the real fields. */}
          <div className="flex items-center gap-1.5">
            <label htmlFor="skill-slug" className="shrink-0 text-xs text-muted-foreground">
              Slug
            </label>
            <div className="relative min-w-0 flex-1">
              {/* Fixed `/` prefix — part of the chat trigger, not the stored
                  value. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 select-none text-xs text-muted-foreground/70"
              >
                /
              </span>
              <Input
                id="skill-slug"
                placeholder="daily-brief"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                aria-invalid={localSlugError || slugError ? true : undefined}
                className={cn(
                  'h-7 rounded-md border-transparent bg-transparent pl-4 pr-2 !text-xs text-muted-foreground shadow-none',
                  'hover:border-border focus-visible:border-border-strong focus-visible:text-foreground',
                  'dark:bg-transparent dark:hover:bg-transparent',
                )}
              />
            </div>
          </div>
          {(localSlugError || slugError) && <p className="text-sm text-destructive">{localSlugError ?? slugError}</p>}
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

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label htmlFor="skill-instruction" className="text-base text-foreground">
            Instructions
          </label>
          <Textarea
            id="skill-instruction"
            placeholder="What the assistant should do…"
            value={instruction}
            onChange={(e) => handleInstructionChange(e.target.value)}
            className="min-h-0 flex-1 resize-none"
          />
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 px-6 py-4">
        {submitError && (
          <p role="alert" className="min-w-0 flex-1 truncate text-sm text-destructive">
            {submitError}
          </p>
        )}
        {/* The outline variant's dark hover (bg-input/50) is invisible on the
            sidebar-surface card; use the accent hover so it reads. */}
        <Button variant="outline" size="lg" onClick={onCancel} className="text-sm dark:hover:bg-accent">
          Cancel
        </Button>
        <Button variant="default" size="lg" disabled={!canSubmit} className="text-sm" onClick={handleSubmit}>
          {mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </footer>
    </section>
  )
}
