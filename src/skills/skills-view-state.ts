/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isWidgetSkillId } from '@/defaults/skills'
import type { Skill } from '@/types'
import type { DependentsAction } from './dependents-dialog'

export type Mode = 'detail' | 'create' | 'edit'
/**
 * Whether the detail surface is showing. On mobile it's the full-screen
 * overlay; on desktop it's the right-hand slide-in panel. `'list'` means only
 * the list is visible.
 */
type PanelView = 'list' | 'panel'

/**
 * "Leave the form" intent: `cancel` returns to detail of the current active
 * skill, `select` switches active to the supplied id, `edit`/`create` open a
 * fresh form on the target. When the form is dirty, `requestLeave` parks the
 * intent in `pendingLeave` so the discard-changes dialog can confirm first.
 */
export type LeaveIntent =
  | { type: 'cancel' }
  | { type: 'select'; id: string }
  | { type: 'edit'; id: string }
  | { type: 'create' }

type PendingLeave = LeaveIntent | null

/** Captured at dialog-open time so a concurrent sync can't redirect the action. */
export type PendingDependents = { action: DependentsAction; skill: Skill; dependents: Skill[] } | null

export type SkillsViewState = {
  mode: Mode
  /** `null` only when the library is empty and nothing has been selected yet. */
  activeId: string | null
  panelView: PanelView
  /** Tracked separately from form values: SkillForm computes it and reports up. */
  isDirty: boolean
  /** Incremented to force SkillForm to re-mount with `initialValues`. */
  resetSignal: number
  pendingLeave: PendingLeave
  pendingDelete: Skill | null
  pendingDependents: PendingDependents
  /** Inline slug error (spec violation or uniqueness) shown under the slug field. */
  slugError: string | null
  /** Generic save-failure message shown near the form's submit button. */
  submitError: string | null
}

export const initialSkillsViewState: SkillsViewState = {
  mode: 'detail',
  activeId: null,
  panelView: 'list',
  isDirty: false,
  resetSignal: 0,
  pendingLeave: null,
  pendingDelete: null,
  pendingDependents: null,
  slugError: null,
  submitError: null,
}

/** Resolve an edit request without exposing widget rendering contracts to forms. */
const modeForSkillEdit = (id: string): Mode => (isWidgetSkillId(id) ? 'detail' : 'edit')

/**
 * Action type for the SkillsView state machine. Each action describes a
 * user-meaningful event (a click, a confirm, a successful mutation) — the
 * reducer maps it to the minimal state delta and any compound transitions
 * (e.g. `SUBMIT_SUCCESS` clears form state, sets active, and returns to
 * detail mode, all in one dispatch).
 */
export type SkillsViewAction =
  /** User selected a skill in the list while in `detail` mode. */
  | { type: 'SELECT_SKILL'; id: string }
  /** User opened the create form. Side effect: panel slides in on mobile. */
  | { type: 'START_CREATE' }
  /** User requested editing a skill. Widget contracts stay in read-only detail. */
  | { type: 'START_EDIT'; id: string }
  /** Leave the form (confirmed) and apply the parked intent. */
  | { type: 'PERFORM_LEAVE'; leave: LeaveIntent }
  /** User asked to leave but the form is dirty — park the intent for the
   *  discard-changes dialog. */
  | { type: 'REQUEST_LEAVE'; leave: LeaveIntent }
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
  /** Form reports its dirty state changed. */
  | { type: 'DIRTY_CHANGED'; dirty: boolean }
  /** Form submit succeeded — return to detail mode on the (possibly new) skill. */
  | { type: 'SUBMIT_SUCCESS'; activeId: string }
  /** Inline slug error from the form's local validator or the DAL. */
  | { type: 'SLUG_REJECTED'; message: string }
  /** User edited the slug — clear any stale uniqueness error. */
  | { type: 'CLEAR_SLUG_ERROR' }
  /** Form submit hit an unexpected persistence failure — keep the form open
   *  with the user's input and show a generic message. */
  | { type: 'SUBMIT_FAILED'; message: string }
  /** Mobile back button on the detail panel / desktop close (X) on the slide-in panel. */
  | { type: 'BACK_TO_LIST' }

export const skillsViewReducer = (state: SkillsViewState, action: SkillsViewAction): SkillsViewState => {
  switch (action.type) {
    case 'SELECT_SKILL':
      return { ...state, activeId: action.id, panelView: 'panel' }

    case 'START_CREATE':
      return {
        ...state,
        mode: 'create',
        slugError: null,
        submitError: null,
        panelView: 'panel',
        // Bump the reset signal so SkillForm remounts with a blank form.
        resetSignal: state.resetSignal + 1,
      }

    case 'START_EDIT':
      return {
        ...state,
        mode: modeForSkillEdit(action.id),
        activeId: action.id,
        slugError: null,
        submitError: null,
        panelView: 'panel',
      }

    case 'PERFORM_LEAVE': {
      const { leave } = action
      const nextActiveId = leave.type === 'select' || leave.type === 'edit' ? leave.id : state.activeId
      // Editable `edit` targets and `create` land in fresh forms. Widget edit
      // targets, `cancel`, and `select` land in detail.
      const nextMode: Mode =
        leave.type === 'edit' ? modeForSkillEdit(leave.id) : leave.type === 'create' ? 'create' : 'detail'
      // `edit`/`create` need the panel open — they can be triggered from a
      // list-row action while panelView is still 'list'. Cancel returns to the
      // selected item's detail view on both mobile and desktop; closing the
      // detail view is a separate action.
      const nextPanelView = leave.type === 'edit' || leave.type === 'create' ? 'panel' : state.panelView
      return {
        ...state,
        activeId: nextActiveId,
        mode: nextMode,
        resetSignal: state.resetSignal + 1,
        isDirty: false,
        slugError: null,
        submitError: null,
        pendingLeave: null,
        panelView: nextPanelView,
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
      // Opening from an edit session can later jump to another skill. Reset
      // form state so it does not bleed into the next detail or edit surface.
      return {
        ...state,
        activeId: action.payload.skill.id,
        pendingDependents: action.payload,
        isDirty: false,
        slugError: null,
        submitError: null,
      }

    case 'CLOSE_DELETE':
      return { ...state, pendingDelete: null }

    case 'CLOSE_DEPENDENTS':
      return { ...state, pendingDependents: null }

    case 'DIRTY_CHANGED':
      return { ...state, isDirty: action.dirty }

    case 'SUBMIT_SUCCESS':
      return {
        ...state,
        activeId: action.activeId,
        mode: 'detail',
        isDirty: false,
        resetSignal: state.resetSignal + 1,
        slugError: null,
        submitError: null,
      }

    case 'SLUG_REJECTED':
      return { ...state, slugError: action.message, submitError: null }

    case 'CLEAR_SLUG_ERROR':
      return state.slugError === null ? state : { ...state, slugError: null }

    case 'SUBMIT_FAILED':
      return { ...state, submitError: action.message }

    case 'BACK_TO_LIST':
      return { ...state, panelView: 'list' }
  }
}
