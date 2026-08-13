/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { deletePrompt, detailReducer, initialDetailState } from './project-detail-state'

describe('detailReducer destructive actions', () => {
  it('holds the delete as pending rather than performing it', () => {
    // The page only calls the DAL from `confirmDelete`, so a request that merely
    // sets this slot is what makes deletion confirmable.
    const state = detailReducer(initialDetailState, { type: 'DELETE_REQUESTED', target: { kind: 'project' } })
    expect(state.pendingDelete).toEqual({ kind: 'project' })
  })

  it('clears the pending delete when dismissed', () => {
    const requested = detailReducer(initialDetailState, {
      type: 'DELETE_REQUESTED',
      target: { kind: 'file', id: 'f1', filename: 'cabin.pdf' },
    })
    expect(detailReducer(requested, { type: 'DELETE_DISMISSED' }).pendingDelete).toBeNull()
  })

  it('keeps one prompt at a time — a second request replaces the first', () => {
    const project = detailReducer(initialDetailState, { type: 'DELETE_REQUESTED', target: { kind: 'project' } })
    const file = detailReducer(project, {
      type: 'DELETE_REQUESTED',
      target: { kind: 'file', id: 'f1', filename: 'cabin.pdf' },
    })
    expect(file.pendingDelete).toEqual({ kind: 'file', id: 'f1', filename: 'cabin.pdf' })
  })

  it('leaves a note draft untouched while a delete is pending', () => {
    const drafting = detailReducer(initialDetailState, {
      type: 'NOTE_DRAFTED',
      draft: { title: 'Roof', content: 'Metal, 6:12 pitch' },
    })
    const state = detailReducer(drafting, { type: 'DELETE_REQUESTED', target: { kind: 'project' } })
    expect(state.draftNote).toEqual({ title: 'Roof', content: 'Metal, 6:12 pitch' })
  })
})

describe('detailReducer save errors', () => {
  it('scopes a failure so it renders where the user is looking', () => {
    const state = detailReducer(initialDetailState, {
      type: 'SAVE_FAILED',
      error: { scope: 'note', message: 'Disk full' },
    })
    expect(state.saveError).toEqual({ scope: 'note', message: 'Disk full' })
  })

  it('clears the error on a successful save', () => {
    const failed = detailReducer(initialDetailState, {
      type: 'SAVE_FAILED',
      error: { scope: 'field', message: 'Nope' },
    })
    expect(detailReducer(failed, { type: 'SAVE_SUCCEEDED' }).saveError).toBeNull()
  })

  it('drops a stale note error when the composer closes', () => {
    // Otherwise reopening the composer shows the previous attempt's failure.
    const failed = detailReducer(initialDetailState, {
      type: 'SAVE_FAILED',
      error: { scope: 'note', message: 'Nope' },
    })
    expect(detailReducer(failed, { type: 'NOTE_DISMISSED' }).saveError).toBeNull()
  })
})

describe('detailReducer note drafts', () => {
  it('starts every project with a clean composer', () => {
    // The page is remounted per project id (see the wrapper in
    // `project-detail.tsx`), so a draft cannot survive a navigation. Before that,
    // navigating A → B kept A's draft *and* its note id, and "Save changes"
    // updated A's row while B was on screen.
    expect(initialDetailState.draftNote).toBeNull()
  })

  it('keeps the note id when the draft is edited, so a save updates rather than inserts', () => {
    const editing = detailReducer(initialDetailState, {
      type: 'NOTE_DRAFTED',
      draft: { id: 'note-1', title: 'Roof', content: 'Metal' },
    })
    const typed = detailReducer(editing, {
      type: 'NOTE_CHANGED',
      draft: { ...editing.draftNote!, content: 'Metal, 6:12 pitch' },
    })
    expect(typed.draftNote).toEqual({ id: 'note-1', title: 'Roof', content: 'Metal, 6:12 pitch' })
  })

  it('discards the draft when the composer is dismissed', () => {
    const editing = detailReducer(initialDetailState, {
      type: 'NOTE_DRAFTED',
      draft: { id: 'note-1', title: 'Roof', content: 'Metal' },
    })
    expect(detailReducer(editing, { type: 'NOTE_DISMISSED' }).draftNote).toBeNull()
  })
})

describe('deletePrompt', () => {
  it('tells the user their chats survive a project deletion', () => {
    // The one non-obvious consequence: chats are orphaned, not removed.
    expect(deletePrompt({ kind: 'project' }).description).toContain('Chats in the project are kept')
  })

  it('names the document it is about to remove', () => {
    const prompt = deletePrompt({ kind: 'file', id: 'f1', filename: 'cabin.pdf' })
    expect(prompt.title).toContain('cabin.pdf')
    expect(prompt.confirmLabel).toBe('Remove')
  })

  it('distinguishes the two confirm labels, so the button never reads generically', () => {
    expect(deletePrompt({ kind: 'project' }).confirmLabel).toBe('Delete project')
  })
})
