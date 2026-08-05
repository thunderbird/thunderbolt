/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, type InputHTMLAttributes, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** The muted label line above a detail-panel field. */
export const FieldLabel = ({ children }: { children: string }) => (
  <p className="text-sm font-medium text-muted-foreground">{children}</p>
)

type EditableFieldState = {
  draft: string
  /** Last stored value seen — lets render detect an external change. */
  prevValue: string
  /** Inline persistence-failure message; cleared on the next edit. */
  saveError: string | null
}

type EditableFieldAction =
  | { type: 'DRAFT_CHANGED'; value: string }
  /** The stored value changed underneath us (a save landing, or a sync from
   *  another device) — re-seed the draft. */
  | { type: 'VALUE_SYNCED'; value: string }
  | { type: 'DISCARDED'; value: string }
  | { type: 'SAVE_FAILED'; message: string }

const editableFieldReducer = (state: EditableFieldState, action: EditableFieldAction): EditableFieldState => {
  switch (action.type) {
    case 'DRAFT_CHANGED':
      return { ...state, draft: action.value, saveError: null }
    case 'VALUE_SYNCED':
      return { draft: action.value, prevValue: action.value, saveError: null }
    case 'DISCARDED':
      return { ...state, draft: action.value, saveError: null }
    case 'SAVE_FAILED':
      return { ...state, saveError: action.message }
  }
}

/**
 * An always-editable text field with a Save / Discard row that appears once
 * the draft differs from the stored value (the branch-design inline-edit
 * idiom). Read-only when `isEditable` is false — renders the value as text.
 * A failed save keeps the dirty draft and reports the failure inline.
 */
export const EditableField = ({
  id,
  label,
  value,
  isEditable,
  allowEmpty = false,
  placeholder,
  validate,
  onSave,
  inputProps,
}: {
  id: string
  label: string
  value: string
  isEditable: boolean
  /** Permit saving an empty draft (e.g. clearing the description). */
  allowEmpty?: boolean
  placeholder?: string
  /** Returns a user-facing error for an invalid draft, or null when valid. */
  validate?: (draft: string) => string | null
  onSave: (draft: string) => Promise<void> | void
  inputProps?: InputHTMLAttributes<HTMLInputElement>
}): ReactNode => {
  const [state, dispatch] = useReducer(editableFieldReducer, { draft: value, prevValue: value, saveError: null })
  // Render-time state adjustment (no effect): re-seed when the stored value
  // changes underneath us.
  if (state.prevValue !== value) {
    dispatch({ type: 'VALUE_SYNCED', value })
  }

  // Compare trimmed-to-trimmed: a stored value with stray whitespace must not
  // read as permanently dirty (Discard could never clear it).
  const trimmed = state.draft.trim()
  const isDirty = trimmed !== value.trim()
  const validationError = isDirty && trimmed !== '' && validate ? validate(trimmed) : null
  const canSave = isDirty && (allowEmpty || trimmed !== '') && !validationError
  const error = validationError ?? state.saveError

  const save = async () => {
    if (!canSave) {
      return
    }
    try {
      await onSave(trimmed)
    } catch (saveError) {
      console.error(`Failed to save agent ${label.toLowerCase()}`, saveError)
      dispatch({ type: 'SAVE_FAILED', message: `Couldn't save the ${label.toLowerCase()}. Please try again.` })
    }
  }

  if (!isEditable) {
    return (
      <div className="flex flex-col gap-1">
        <FieldLabel>{label}</FieldLabel>
        {/* `||`, not `??`: an empty stored string also renders the em dash. */}
        <p className="truncate text-base text-foreground">{value || '—'}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={state.draft}
        placeholder={placeholder}
        onChange={(e) => dispatch({ type: 'DRAFT_CHANGED', value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void save()
          }
        }}
        aria-invalid={error ? true : undefined}
        className="h-9"
        {...inputProps}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {isDirty && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'DISCARDED', value })}>
            Discard
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </div>
  )
}
