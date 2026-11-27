/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useReducer } from 'react'
import type { PanelDirt } from '../../components/use-resource-page-state'

export type ConnectionKind = 'oidc' | 'saml' | 'scim'

export type NewConnectionEditorState = {
  /** The kind picked, or null while the picker shows. */
  kind: ConnectionKind | null
  isDirty: PanelDirt
  /** Back was pressed on a form holding unsaved input: the discard prompt is open. */
  confirmingBack: boolean
}

type NewConnectionEditorAction =
  | { type: 'pick'; kind: ConnectionKind }
  | { type: 'dirty'; dirty: PanelDirt }
  | { type: 'confirmBack' }
  | { type: 'cancelBack' }
  | { type: 'back' }

export const initialNewConnectionEditorState: NewConnectionEditorState = {
  kind: null,
  isDirty: false,
  confirmingBack: false,
}

/** Moves the `new` panel between the picker, a form, and the discard prompt guarding the form's Back. */
export const newConnectionEditorReducer = (
  state: NewConnectionEditorState,
  action: NewConnectionEditorAction,
): NewConnectionEditorState => {
  switch (action.type) {
    case 'pick':
      return { ...state, kind: action.kind }
    case 'dirty':
      return { ...state, isDirty: action.dirty }
    case 'confirmBack':
      return { ...state, confirmingBack: true }
    case 'cancelBack':
      return { ...state, confirmingBack: false }
    case 'back':
      return initialNewConnectionEditorState
  }
}

/**
 * The `new` panel's state: the picked kind and whether its form holds unsaved input, which the
 * parent hears through `onDirty`. Back returns to the picker, asking first when the form is dirty.
 */
export const useNewConnectionEditorState = (onDirty: (dirty: PanelDirt) => void) => {
  const [state, dispatch] = useReducer(newConnectionEditorReducer, initialNewConnectionEditorState)

  const trackDirty = (dirty: PanelDirt) => {
    dispatch({ type: 'dirty', dirty })
    onDirty(dirty)
  }
  const back = () => {
    onDirty(false)
    dispatch({ type: 'back' })
  }

  return {
    kind: state.kind,
    confirmingBack: state.confirmingBack,
    pick: (kind: ConnectionKind) => dispatch({ type: 'pick', kind }),
    trackDirty,
    requestBack: () => (state.isDirty ? dispatch({ type: 'confirmBack' }) : back()),
    cancelBack: () => dispatch({ type: 'cancelBack' }),
    confirmBack: back,
  }
}
