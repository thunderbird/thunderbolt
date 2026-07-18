/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { slugifySkillName, validateSkillName } from '@/dal'
import { cn } from '@/lib/utils'

export type SkillFormMode = 'create' | 'edit'

export type SkillFormValues = {
  /** Slug — stored in the `name` column; the `/token` used in chat. */
  name: string
  /** Human display name. */
  label: string
  description: string
  instruction: string
}

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
  onNameChange,
  resetSignal,
  mode = 'create',
  initialValues,
  nameError,
}: {
  onCancel: () => void
  onSubmit: (values: SkillFormValues) => void
  onDirtyChange?: (dirty: boolean) => void
  /** Fires whenever the user edits the slug (directly or via auto-generation).
   *  Used to clear stale parent-side uniqueness errors so they don't persist
   *  past the edit that invalidates them. */
  onNameChange?: () => void
  /** Increment to force the form to reset back to {@link initialValues}. */
  resetSignal?: number
  mode?: SkillFormMode
  initialValues?: SkillFormValues
  /** Inline slug-uniqueness error from the DAL pre-check. */
  nameError?: string | null
}) => {
  // Strip a leading `/` defensively — slugs are stored bare per the
  // AgentSkills spec, but legacy rows from before THU-534 landed may still
  // carry the prefix and we don't want the editor to show `//foo`.
  const initialSlug = (initialValues?.name ?? '').replace(/^\/+/, '')
  const initialLabel = initialValues?.label ?? ''
  const initialDescription = initialValues?.description ?? ''
  const initialInstruction = initialValues?.instruction ?? ''

  const [label, setLabel] = useState(initialLabel)
  const [slug, setSlug] = useState(initialSlug)
  const [description, setDescription] = useState(initialDescription)
  const [instruction, setInstruction] = useState(initialInstruction)
  // Once true, typing in Name stops regenerating the slug. Editing an
  // existing skill, or arriving with a pre-filled slug (the chat's
  // "Create it" deep link), starts detached.
  const [slugEdited, setSlugEdited] = useState(mode === 'edit' || initialSlug !== '')

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
    !nameError

  // Compute dirty against a hypothetical next-state so each onChange handler
  // can report it before React has applied the setState. Avoids the
  // useEffect-notifying-parent anti-pattern.
  const computeDirty = (next: { label: string; slug: string; description: string; instruction: string }) =>
    mode === 'edit'
      ? next.label !== initialLabel ||
        next.slug !== initialSlug ||
        next.description !== initialDescription ||
        next.instruction !== initialInstruction
      : next.label.length > 0 || next.slug.length > 0 || next.description.length > 0 || next.instruction.length > 0

  const handleLabelChange = (value: string) => {
    setLabel(value)
    const nextSlug = slugEdited ? slug : slugifySkillName(value)
    if (!slugEdited) {
      setSlug(nextSlug)
      // Auto-generation changed the slug value → any stale uniqueness error
      // now refers to a slug we're no longer submitting.
      onNameChange?.()
    }
    onDirtyChange?.(computeDirty({ label: value, slug: nextSlug, description, instruction }))
  }
  const handleSlugChange = (raw: string) => {
    const typedSlug = raw.replace(/^\/+/, '')
    // Clearing the slug hands control back to auto-generation from the Name —
    // create mode only. Edit mode stays detached so an existing skill's slug
    // is never auto-rewritten (renames must not silently break `/tokens`).
    const isDetached = mode === 'edit' || typedSlug !== ''
    const nextSlug = isDetached ? typedSlug : slugifySkillName(label)
    setSlugEdited(isDetached)
    setSlug(nextSlug)
    onDirtyChange?.(computeDirty({ label, slug: nextSlug, description, instruction }))
    // A "slug already exists" error from the parent applies to the *previous*
    // value; clear it as soon as the user edits so they don't see a stale
    // message about a slug they're no longer trying to submit.
    onNameChange?.()
  }
  const handleDescriptionChange = (value: string) => {
    setDescription(value)
    onDirtyChange?.(computeDirty({ label, slug, description: value, instruction }))
  }
  const handleInstructionChange = (value: string) => {
    setInstruction(value)
    onDirtyChange?.(computeDirty({ label, slug, description, instruction: value }))
  }

  const [prevResetSignal, setPrevResetSignal] = useState(resetSignal)
  if (resetSignal !== undefined && prevResetSignal !== resetSignal) {
    setPrevResetSignal(resetSignal)
    setLabel(initialLabel)
    setSlug(initialSlug)
    setSlugEdited(mode === 'edit' || initialSlug !== '')
    setDescription(initialDescription)
    setInstruction(initialInstruction)
    // Parent already knows it triggered the reset; it sets its own isDirty
    // back to false in the same handler, so no notification needed here.
  }

  const handleSubmit = () => {
    if (!canSubmit) {
      return
    }
    onSubmit({
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
                aria-invalid={localSlugError || nameError ? true : undefined}
                className={cn(
                  'h-7 rounded-md border-transparent bg-transparent pl-4 pr-2 !text-xs text-muted-foreground shadow-none',
                  'hover:border-border focus-visible:border-border-strong focus-visible:text-foreground',
                  'dark:bg-transparent dark:hover:bg-transparent',
                )}
              />
            </div>
          </div>
          {(localSlugError || nameError) && <p className="text-sm text-destructive">{localSlugError ?? nameError}</p>}
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
