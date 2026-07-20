/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useState } from 'react'

import { slugifySkillName } from '@/dal'

export type SkillFormMode = 'create' | 'edit'

export type SkillFormValues = {
  /** Slug — stored in the `name` column; the `/token` used in chat. */
  name: string
  /** Human display name. */
  label: string
  description: string
  instruction: string
}

export type SkillFormState = {
  mode: SkillFormMode
  label: string
  slug: string
  description: string
  instruction: string
  /** Once true, typing in Name stops regenerating the slug. */
  isSlugDetached: boolean
}

/** User-meaningful form events; the reducer maps each to a state delta. */
export type SkillFormAction =
  | { type: 'LABEL_CHANGED'; value: string }
  | { type: 'SLUG_CHANGED'; value: string }
  | { type: 'DESCRIPTION_CHANGED'; value: string }
  | { type: 'INSTRUCTION_CHANGED'; value: string }
  /** Rewind to the given initial values (the parent's `resetSignal` bumped). */
  | { type: 'RESET'; initialValues?: SkillFormValues }

/**
 * Builds the form state for the given mode and (optional) initial values.
 * Strips a leading `/` defensively — slugs are stored bare per the
 * AgentSkills spec, but legacy rows from before THU-534 landed may still
 * carry the prefix and we don't want the editor to show `//foo`.
 *
 * Editing an existing skill, or arriving with a pre-filled slug (the chat's
 * "Create it" deep link), starts with the slug detached from Name
 * auto-generation.
 */
export const createSkillFormState = (mode: SkillFormMode, initialValues?: SkillFormValues): SkillFormState => {
  const initialSlug = (initialValues?.name ?? '').replace(/^\/+/, '')
  return {
    mode,
    label: initialValues?.label ?? '',
    slug: initialSlug,
    description: initialValues?.description ?? '',
    instruction: initialValues?.instruction ?? '',
    isSlugDetached: mode === 'edit' || initialSlug !== '',
  }
}

/**
 * Pure transition function for the skill form. The slug auto-generates from
 * the label until the user edits the slug directly (clearing the slug hands
 * control back to auto-generation — create mode only; edit mode never
 * auto-rewrites the slug, since renaming an existing skill must not silently
 * break `/tokens` already used in chats).
 */
export const skillFormReducer = (state: SkillFormState, action: SkillFormAction): SkillFormState => {
  switch (action.type) {
    case 'LABEL_CHANGED':
      return {
        ...state,
        label: action.value,
        slug: state.isSlugDetached ? state.slug : slugifySkillName(action.value),
      }

    case 'SLUG_CHANGED': {
      const typedSlug = action.value.replace(/^\/+/, '')
      const isSlugDetached = state.mode === 'edit' || typedSlug !== ''
      return {
        ...state,
        isSlugDetached,
        slug: isSlugDetached ? typedSlug : slugifySkillName(state.label),
      }
    }

    case 'DESCRIPTION_CHANGED':
      return { ...state, description: action.value }

    case 'INSTRUCTION_CHANGED':
      return { ...state, instruction: action.value }

    case 'RESET':
      return createSkillFormState(state.mode, action.initialValues)
  }
}

/**
 * Whether leaving the form now would lose work: any divergence from the
 * initial values. Applies to create mode too — a deep-linked create form
 * with pre-filled values isn't dirty until the user actually edits it (for
 * a blank create, this degenerates to "any non-empty field").
 */
export const isSkillFormDirty = (state: SkillFormState, initial: SkillFormState): boolean =>
  state.label !== initial.label ||
  state.slug !== initial.slug ||
  state.description !== initial.description ||
  state.instruction !== initial.instruction

/**
 * Reducer-backed state for `SkillForm`. Each change handler runs the pure
 * reducer eagerly so it can report dirty state (and slug-change
 * notifications) to the parent from the event handler itself — before React
 * applies the dispatch — avoiding the useEffect-notifying-parent
 * anti-pattern. `resetSignal` increments rewind the form to its initial
 * values via a render-phase adjustment (no effect).
 */
export const useSkillFormState = ({
  mode,
  initialValues,
  resetSignal,
  onDirtyChange,
  onSlugChange,
}: {
  mode: SkillFormMode
  initialValues?: SkillFormValues
  resetSignal?: number
  onDirtyChange?: (dirty: boolean) => void
  onSlugChange?: () => void
}) => {
  const [state, dispatch] = useReducer(skillFormReducer, undefined, () => createSkillFormState(mode, initialValues))

  const [prevResetSignal, setPrevResetSignal] = useState(resetSignal)
  if (resetSignal !== undefined && prevResetSignal !== resetSignal) {
    setPrevResetSignal(resetSignal)
    dispatch({ type: 'RESET', initialValues })
    // Parent already knows it triggered the reset; it sets its own isDirty
    // back to false in the same handler, so no notification needed here.
  }

  // Dirty is always measured against the live initial values, so a reset (or
  // a prop update under the same key) can't leave the comparison stale.
  const initialState = createSkillFormState(mode, initialValues)

  // Compute the next state eagerly (the reducer is pure, so this matches
  // what React will apply) so handlers can notify the parent synchronously.
  const applyAction = (action: SkillFormAction): SkillFormState => {
    const next = skillFormReducer(state, action)
    dispatch(action)
    return next
  }

  const handleLabelChange = (value: string) => {
    const next = applyAction({ type: 'LABEL_CHANGED', value })
    if (!state.isSlugDetached) {
      // Auto-generation changed the slug value → any stale uniqueness error
      // now refers to a slug we're no longer submitting.
      onSlugChange?.()
    }
    onDirtyChange?.(isSkillFormDirty(next, initialState))
  }

  const handleSlugChange = (value: string) => {
    const next = applyAction({ type: 'SLUG_CHANGED', value })
    onDirtyChange?.(isSkillFormDirty(next, initialState))
    // A "slug already exists" error from the parent applies to the *previous*
    // value; clear it as soon as the user edits so they don't see a stale
    // message about a slug they're no longer trying to submit.
    onSlugChange?.()
  }

  const handleDescriptionChange = (value: string) => {
    onDirtyChange?.(isSkillFormDirty(applyAction({ type: 'DESCRIPTION_CHANGED', value }), initialState))
  }

  const handleInstructionChange = (value: string) => {
    onDirtyChange?.(isSkillFormDirty(applyAction({ type: 'INSTRUCTION_CHANGED', value }), initialState))
  }

  return {
    label: state.label,
    slug: state.slug,
    description: state.description,
    instruction: state.instruction,
    handleLabelChange,
    handleSlugChange,
    handleDescriptionChange,
    handleInstructionChange,
  }
}
