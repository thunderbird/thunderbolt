/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Skill } from '@/types'
import type { DependentsAction } from './dependents-dialog'

export type Mode = 'detail' | 'create' | 'edit'
export type MobileView = 'list' | 'panel'

/**
 * Pending "leave the form" intent. The user typed in the create/edit form
 * and now wants to navigate away — `requestLeave` parks the intent here so
 * the discard-changes dialog can confirm before applying it.
 */
export type PendingLeave = { type: 'cancel' } | { type: 'select'; id: string } | null

/** Captured at dialog-open time so a concurrent sync can't redirect the action. */
export type PendingDependents = { action: DependentsAction; skill: Skill; dependents: Skill[] } | null

export type SkillsViewState = {
  mode: Mode
  /** `null` only when the library is empty and nothing has been selected yet. */
  activeId: string | null
  mobileView: MobileView
  /** Tracked separately from form values: SkillForm computes it and reports up. */
  isDirty: boolean
  /** Incremented to force SkillForm to re-mount with `initialValues`. */
  resetSignal: number
  pendingLeave: PendingLeave
  pendingDelete: Skill | null
  pendingDependents: PendingDependents
  nameError: string | null
  /**
   * Optional initial name for the create form — set when a "create it" deep
   * link arrives from the chat composer's broken-reference alert. `null`
   * for an empty form. Cleared on submit / leave.
   */
  createInitialName: string | null
}

export const initialSkillsViewState: SkillsViewState = {
  mode: 'detail',
  activeId: null,
  mobileView: 'list',
  isDirty: false,
  resetSignal: 0,
  pendingLeave: null,
  pendingDelete: null,
  pendingDependents: null,
  nameError: null,
  createInitialName: null,
}

/**
 * Action type for the SkillsView state machine. Each action describes a
 * user-meaningful event (a click, a confirm, a successful mutation) — the
 * reducer maps it to the minimal state delta and any compound transitions
 * (e.g. `JUMP_TO_DEPENDENT` clears the dialog, sets active, sets mode,
 * and on mobile slides the panel in, all in one dispatch).
 */
export type SkillsViewAction =
  /** User selected a skill in the list while in `detail` mode. */
  | { type: 'SELECT_SKILL'; id: string }
  /** User opened the create form. Side effect: panel slides in on mobile.
   * `initialName` pre-fills the form when arriving from a "create it" deep
   * link out of the chat composer. */
  | { type: 'START_CREATE'; initialName?: string }
  /** User opened the edit form for a specific skill. */
  | { type: 'START_EDIT'; id: string }
  /** Leave the form (confirmed). `cancel` returns to detail of the current
   *  active skill; `select` switches active to the supplied id. */
  | { type: 'PERFORM_LEAVE'; leave: { type: 'cancel' } | { type: 'select'; id: string }; isMobile: boolean }
  /** User asked to leave but the form is dirty — park the intent for the
   *  discard-changes dialog. */
  | { type: 'REQUEST_LEAVE'; leave: { type: 'cancel' } | { type: 'select'; id: string } }
  /** User dismissed the discard-changes dialog without confirming. */
  | { type: 'CANCEL_DISCARD' }
  /** Open the delete confirm dialog for a snapshot of the target skill. */
  | { type: 'OPEN_DELETE'; skill: Skill }
  /** Open the dependents-aware confirm dialog. */
  | { type: 'OPEN_DEPENDENTS'; payload: { action: DependentsAction; skill: Skill; dependents: Skill[] } }
  /** Close the delete confirm dialog. */
  | { type: 'CLOSE_DELETE' }
  /** Close the dependents confirm dialog (cancelled or confirmed). */
  | { type: 'CLOSE_DEPENDENTS' }
  /** User clicked a row in the dependents dialog — jump to edit that skill. */
  | { type: 'JUMP_TO_DEPENDENT'; id: string; isMobile: boolean }
  /** Form reports its dirty state changed. */
  | { type: 'SET_DIRTY'; dirty: boolean }
  /** Form submit succeeded — return to detail mode on the (possibly new) skill. */
  | { type: 'SUBMIT_SUCCESS'; activeId: string }
  /** Inline name-error from the form's local validator or the DAL. */
  | { type: 'SET_NAME_ERROR'; message: string }
  /** User edited the name field — clear any stale uniqueness error. */
  | { type: 'CLEAR_NAME_ERROR' }
  /** Mobile back button on the detail panel. */
  | { type: 'BACK_TO_LIST' }

export const skillsViewReducer = (state: SkillsViewState, action: SkillsViewAction): SkillsViewState => {
  switch (action.type) {
    case 'SELECT_SKILL':
      return { ...state, activeId: action.id, mobileView: 'panel' }

    case 'START_CREATE':
      return {
        ...state,
        mode: 'create',
        nameError: null,
        mobileView: 'panel',
        createInitialName: action.initialName ?? null,
        // Bump the reset signal so SkillForm remounts with the new initial
        // values when the user clicks "Create it" twice for different slugs.
        resetSignal: state.resetSignal + 1,
      }

    case 'START_EDIT':
      return { ...state, mode: 'edit', activeId: action.id, nameError: null, mobileView: 'panel' }

    case 'PERFORM_LEAVE': {
      const nextActiveId = action.leave.type === 'select' ? action.leave.id : state.activeId
      // On mobile a `cancel` should drop the user back to the list. Driving
      // this here (not in the form's onCancel) means the panel stays visible
      // while the discard-confirmation dialog is open — if the user picks
      // "Keep editing" the form remains accessible.
      const nextMobileView = action.isMobile && action.leave.type === 'cancel' ? 'list' : state.mobileView
      return {
        ...state,
        activeId: nextActiveId,
        mode: 'detail',
        resetSignal: state.resetSignal + 1,
        isDirty: false,
        nameError: null,
        pendingLeave: null,
        mobileView: nextMobileView,
        createInitialName: null,
      }
    }

    case 'REQUEST_LEAVE':
      return { ...state, pendingLeave: action.leave }

    case 'CANCEL_DISCARD':
      return { ...state, pendingLeave: null }

    case 'OPEN_DELETE':
      // Snapshot the skill — concurrent syncs can't redirect the delete.
      return { ...state, activeId: action.skill.id, pendingDelete: action.skill }

    case 'OPEN_DEPENDENTS':
      // Opening the dependents dialog from inside an edit session can later
      // trigger JUMP_TO_DEPENDENT, which starts a fresh edit on another skill.
      // Reset `isDirty` and `nameError` now so the inherited edit-session state
      // doesn't bleed into the new form.
      return {
        ...state,
        activeId: action.payload.skill.id,
        pendingDependents: action.payload,
        isDirty: false,
        nameError: null,
      }

    case 'CLOSE_DELETE':
      return { ...state, pendingDelete: null }

    case 'CLOSE_DEPENDENTS':
      return { ...state, pendingDependents: null }

    case 'JUMP_TO_DEPENDENT':
      // Fresh edit session on a different skill: clear `isDirty` and
      // `nameError` so a stale dirty flag from the prior form doesn't trigger
      // a spurious discard-changes dialog on the new (untouched) form.
      // SkillForm remounts via its `key` change, so the values themselves are
      // already clean — this resets the parent's tracking state to match.
      return {
        ...state,
        activeId: action.id,
        mode: 'edit',
        pendingDependents: null,
        isDirty: false,
        nameError: null,
        // The dependents dialog can be opened from a list-row action while
        // mobileView is still 'list'; sliding the panel in here gives the
        // edit form a surface to render on.
        mobileView: action.isMobile ? 'panel' : state.mobileView,
      }

    case 'SET_DIRTY':
      return { ...state, isDirty: action.dirty }

    case 'SUBMIT_SUCCESS':
      return {
        ...state,
        activeId: action.activeId,
        mode: 'detail',
        isDirty: false,
        resetSignal: state.resetSignal + 1,
        nameError: null,
        createInitialName: null,
      }

    case 'SET_NAME_ERROR':
      return { ...state, nameError: action.message }

    case 'CLEAR_NAME_ERROR':
      return state.nameError === null ? state : { ...state, nameError: null }

    case 'BACK_TO_LIST':
      return { ...state, mobileView: 'list' }
  }
}
