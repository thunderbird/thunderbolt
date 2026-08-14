/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The list page's overlay reducer. Selection is NOT here — it lives in the route
 * (`/projects/:projectId`), which is the point of these tests: what remains in
 * state is only what the URL can't express.
 */

import { describe, expect, it } from 'bun:test'
import { initialViewState, projectsViewReducer } from './projects-view-state'

describe('projectsViewReducer', () => {
  it('opens with no overlay and nothing pending', () => {
    expect(initialViewState.overlay).toBe('none')
    expect(initialViewState.isDeleteRequested).toBe(false)
  })

  it('opens the create form', () => {
    expect(projectsViewReducer(initialViewState, { type: 'CREATE_STARTED' }).overlay).toBe('create')
  })

  it('switches the panel into edit', () => {
    expect(projectsViewReducer(initialViewState, { type: 'EDIT_STARTED' }).overlay).toBe('edit')
  })

  it('returns to the read-only panel when the overlay closes', () => {
    const editing = projectsViewReducer(initialViewState, { type: 'EDIT_STARTED' })
    expect(projectsViewReducer(editing, { type: 'OVERLAY_CLOSED' }).overlay).toBe('none')
  })

  it('holds a delete as pending rather than performing it', () => {
    // The page only calls the DAL from the dialog's onConfirm, so this flag is
    // what makes the ⋯ → Delete path confirmable.
    expect(projectsViewReducer(initialViewState, { type: 'DELETE_REQUESTED' }).isDeleteRequested).toBe(true)
  })

  it('abandons a pending delete on dismiss', () => {
    const pending = projectsViewReducer(initialViewState, { type: 'DELETE_REQUESTED' })
    expect(projectsViewReducer(pending, { type: 'DELETE_DISMISSED' }).isDeleteRequested).toBe(false)
  })

  it('drops a pending delete when the panel closes', () => {
    // Otherwise closing the panel and reopening another project could resurface a
    // confirmation aimed at the project you just left.
    const pending = projectsViewReducer(initialViewState, { type: 'DELETE_REQUESTED' })
    expect(projectsViewReducer(pending, { type: 'OVERLAY_CLOSED' }).isDeleteRequested).toBe(false)
  })

  it('keeps the search term across overlay changes', () => {
    const searched = projectsViewReducer(initialViewState, { type: 'SEARCH_CHANGED', value: 'cabin' })
    const creating = projectsViewReducer(searched, { type: 'CREATE_STARTED' })
    expect(projectsViewReducer(creating, { type: 'OVERLAY_CLOSED' }).search).toBe('cabin')
  })
})
