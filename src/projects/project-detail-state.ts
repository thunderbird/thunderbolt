/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * View state for the project detail page: the note being composed, the
 * destructive action awaiting confirmation, and any failed write.
 *
 * Split from the page so the transitions and the prompt copy can be tested
 * without rendering a database-backed page.
 */

/** A note being composed or edited. `id` present = editing an existing note. */
export type NoteDraft = { id?: string; title: string; content: string }

/**
 * A destructive action awaiting confirmation. Both live in one slot because only
 * one prompt can be open, and the dialog renders whichever is pending.
 */
export type PendingDelete = { kind: 'project' } | { kind: 'file'; id: string; filename: string }

/**
 * A failed write, tagged with where it belongs: `field` renders under the name
 * input, `note` inside the note composer. Without the scope a note failure would
 * surface next to a field the user isn't looking at.
 *
 * `field` doubles as the page-level slot — a failed delete lands there, since the
 * confirmation dialog and the note composer are both closed by the time it fails.
 */
export type SaveError = { scope: 'field' | 'note'; message: string }

/** Note-composer state, the pending destructive action, and any save error. */
export type DetailState = {
  draftNote: NoteDraft | null
  pendingDelete: PendingDelete | null
  saveError: SaveError | null
}

export type DetailAction =
  | { type: 'NOTE_DRAFTED'; draft: NoteDraft }
  | { type: 'NOTE_CHANGED'; draft: NoteDraft }
  | { type: 'NOTE_DISMISSED' }
  | { type: 'DELETE_REQUESTED'; target: PendingDelete }
  | { type: 'DELETE_DISMISSED' }
  | { type: 'SAVE_FAILED'; error: SaveError }
  | { type: 'SAVE_SUCCEEDED' }

export const initialDetailState: DetailState = { draftNote: null, pendingDelete: null, saveError: null }

export const detailReducer = (state: DetailState, action: DetailAction): DetailState => {
  switch (action.type) {
    case 'NOTE_DRAFTED':
    case 'NOTE_CHANGED':
      return { ...state, draftNote: action.draft }
    case 'NOTE_DISMISSED':
      return { ...state, draftNote: null, saveError: null }
    case 'DELETE_REQUESTED':
      return { ...state, pendingDelete: action.target }
    case 'DELETE_DISMISSED':
      return { ...state, pendingDelete: null }
    case 'SAVE_FAILED':
      return { ...state, saveError: action.error }
    case 'SAVE_SUCCEEDED':
      return { ...state, saveError: null }
  }
}

/** Copy for the confirmation prompt, per target. */
export const deletePrompt = (target: PendingDelete): { title: string; description: string; confirmLabel: string } =>
  target.kind === 'project'
    ? {
        title: 'Delete this project?',
        description:
          'Its instructions, knowledge, and notes are removed. Chats in the project are kept and become ordinary chats.',
        confirmLabel: 'Delete project',
      }
    : {
        title: `Remove “${target.filename}”?`,
        description: 'It stops being part of this project’s knowledge, so future chats here will no longer see it.',
        confirmLabel: 'Remove',
      }
