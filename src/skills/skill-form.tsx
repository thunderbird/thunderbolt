/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScopePicker, type ResourceScope } from '@/components/scope-picker'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { validateSkillName } from '@/dal'

export type SkillFormMode = 'create' | 'edit'

export type SkillFormValues = {
  name: string
  description: string
  instruction: string
  /** Defaults to `'workspace'` when omitted. Edit mode preserves the row's
   *  current scope (immutable on existing rows per the BE handler). */
  scope: ResourceScope
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
  onNameChange,
  resetSignal,
  mode = 'create',
  initialValues,
  nameError,
  showScopePicker = false,
}: {
  onCancel: () => void
  onSubmit: (values: SkillFormValues) => void
  onDirtyChange?: (dirty: boolean) => void
  /** Fires whenever the user edits the name. Used to clear stale parent-side
   *  uniqueness errors so they don't persist past the edit that invalidates them. */
  onNameChange?: () => void
  /** Increment to force the form to reset back to {@link initialValues}. */
  resetSignal?: number
  mode?: SkillFormMode
  initialValues?: SkillFormValues
  /** Inline name-uniqueness error from the DAL pre-check. */
  nameError?: string | null
  /** Mount the per-row scope picker (THU-603). Production callers pass the
   *  value of `useScopePickerEnabled()`; tests/stories default to `false`. */
  showScopePicker?: boolean
}) => {
  // Strip a leading `/` defensively — names are stored bare per the
  // AgentSkills spec, but legacy rows from before THU-534 landed may still
  // carry the prefix and we don't want the editor to show `//foo`.
  const initialName = (initialValues?.name ?? '').replace(/^\/+/, '')
  const initialDescription = initialValues?.description ?? ''
  const initialInstruction = initialValues?.instruction ?? ''
  const initialScope: ResourceScope = initialValues?.scope ?? 'workspace'

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [instruction, setInstruction] = useState(initialInstruction)
  const [scope, setScope] = useState<ResourceScope>(initialScope)
  // The parent decides when the picker is interactive — for edit mode it
  // typically also requires the active user to be the row's author (the BE
  // applies scope changes only when the caller owns the row).
  const renderScopePicker = showScopePicker

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
  // trimmed value — `handleSubmit` submits the trimmed name, so the two must
  // agree (otherwise " meeting-notes " reads as invalid even though it isn't).
  const trimmedName = name.trim()
  const localNameError = trimmedName === '' ? null : validateSkillName(trimmedName)
  // Block submission while a server-side name error (e.g. SkillNameTakenError) is
  // still showing — `handleNameChange` clears it as soon as the user edits the
  // name, so the button re-enables on the next keystroke.
  const canSubmit =
    trimmedName !== '' &&
    description.trim() !== '' &&
    instruction.trim() !== '' &&
    localNameError === null &&
    !nameError

  // Compute dirty against a hypothetical next-state so each onChange handler
  // can report it before React has applied the setState. Avoids the
  // useEffect-notifying-parent anti-pattern.
  const computeDirty = (next: { name: string; description: string; instruction: string; scope: ResourceScope }) =>
    mode === 'edit'
      ? next.name !== initialName ||
        next.description !== initialDescription ||
        next.instruction !== initialInstruction ||
        next.scope !== initialScope
      : next.name.length > 0 ||
        next.description.length > 0 ||
        next.instruction.length > 0 ||
        next.scope !== initialScope

  const handleNameChange = (raw: string) => {
    const v = raw.replace(/^\/+/, '')
    setName(v)
    onDirtyChange?.(computeDirty({ name: v, description, instruction, scope }))
    // A "name already exists" error from the parent applies to the *previous*
    // value; clear it as soon as the user edits so they don't see a stale
    // message about a name they're no longer trying to submit.
    onNameChange?.()
  }
  const handleDescriptionChange = (v: string) => {
    setDescription(v)
    onDirtyChange?.(computeDirty({ name, description: v, instruction, scope }))
  }
  const handleInstructionChange = (v: string) => {
    setInstruction(v)
    onDirtyChange?.(computeDirty({ name, description, instruction: v, scope }))
  }
  const handleScopeChange = (next: ResourceScope) => {
    setScope(next)
    onDirtyChange?.(computeDirty({ name, description, instruction, scope: next }))
  }

  const [prevResetSignal, setPrevResetSignal] = useState(resetSignal)
  if (resetSignal !== undefined && prevResetSignal !== resetSignal) {
    setPrevResetSignal(resetSignal)
    setName(initialName)
    setDescription(initialDescription)
    setInstruction(initialInstruction)
    setScope(initialScope)
    // Parent already knows it triggered the reset; it sets its own isDirty
    // back to false in the same handler, so no notification needed here.
  }

  const handleSubmit = () => {
    if (!canSubmit) {
      return
    }
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      instruction: instruction.trim(),
      scope,
    })
  }

  return (
    <section className="flex h-full flex-1 flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
        <h2 className="text-xl text-foreground">{mode === 'edit' ? 'Edit Skill' : 'Create Skill'}</h2>

        {renderScopePicker && (
          <ScopePicker id="skill-scope" value={scope} onChange={handleScopeChange} label="Visibility" />
        )}

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
              ref={nameInputRef}
              placeholder="daily-brief"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              className="h-9 pl-7"
              aria-invalid={localNameError || nameError ? true : undefined}
            />
          </div>
          {(localNameError || nameError) && <p className="text-sm text-destructive">{localNameError ?? nameError}</p>}
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
