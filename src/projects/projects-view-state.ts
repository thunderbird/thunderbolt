/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the slide-out is showing *beyond* the selection, which lives in the URL
 * (`/projects/:projectId`). Keeping selection in the route rather than in state
 * means a deep link, a sidebar row, a search hit and the chat badge all open the
 * same panel, with no effect syncing a param into a `useState`.
 */
export type PanelOverlay = 'none' | 'create' | 'edit'

export type ProjectsViewState = {
  search: string
  overlay: PanelOverlay
  /** Deleting from the panel's ⋯ menu is confirmed first — a project's
   *  instructions aren't recoverable from the UI once it's gone. */
  isDeleteRequested: boolean
}

export type ProjectsViewAction =
  | { type: 'SEARCH_CHANGED'; value: string }
  | { type: 'CREATE_STARTED' }
  | { type: 'EDIT_STARTED' }
  | { type: 'OVERLAY_CLOSED' }
  | { type: 'DELETE_REQUESTED' }
  | { type: 'DELETE_DISMISSED' }

export const initialViewState: ProjectsViewState = { search: '', overlay: 'none', isDeleteRequested: false }

export const projectsViewReducer = (state: ProjectsViewState, action: ProjectsViewAction): ProjectsViewState => {
  switch (action.type) {
    case 'SEARCH_CHANGED':
      return { ...state, search: action.value }
    case 'CREATE_STARTED':
      return { ...state, overlay: 'create' }
    case 'EDIT_STARTED':
      return { ...state, overlay: 'edit' }
    // Back to the read-only panel rather than closing: after saving, the thing you
    // just edited is what you want to see.
    case 'OVERLAY_CLOSED':
      return { ...state, overlay: 'none', isDeleteRequested: false }
    case 'DELETE_REQUESTED':
      return { ...state, isDeleteRequested: true }
    case 'DELETE_DISMISSED':
      return { ...state, isDeleteRequested: false }
  }
}
