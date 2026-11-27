/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useReducer } from 'react'
import { useConsumeNavState } from '@/hooks/use-consume-nav-state'

/** The router-state key another screen sets to open one item here: see `adminItemLink`. */
const openItemStateKey = 'adminOpenItem'

/** Where a link to one item on an admin screen goes, and the state that opens its panel there. */
export const adminItemLink = (path: string, itemId: string) => ({ to: path, state: { [openItemStateKey]: itemId } })

/** Whether a selection id is a create panel: `new`, or a `new-…` step such as the add-domain form. */
const isCreatingId = (id: string) => id === 'new' || id.startsWith('new-')

/** A selection: the open item, and whether its panel is the edit form rather than the view. */
type Selection = { id: string | null; editing?: boolean }

/**
 * Whether the open panel holds work a close would lose: unsaved edits, or `'secret'` for a one-time
 * secret (a SCIM token) shown but maybe not yet copied.
 */
export type PanelDirt = boolean | 'secret'

type PageState = {
  selectedId: string | null
  isEditing: boolean
  dirty: PanelDirt
  pendingSelection: Selection | null
  removeId: string | null
}

const initialState: PageState = {
  selectedId: null,
  isEditing: false,
  dirty: false,
  pendingSelection: null,
  removeId: null,
}

/**
 * The open item of an admin list page and whether its panel is the edit form, held in component
 * state like the settings pages. A link from another screen opens an item through router state
 * (`adminItemLink`). Protects local drafts when selecting or closing a panel; `new` is always a form.
 */
export const useResourcePageState = () => {
  const [state, patch] = useReducer(
    (current: PageState, update: Partial<PageState>) => ({ ...current, ...update }),
    initialState,
  )
  const select = (id: string | null, { editing = false }: { editing?: boolean } = {}) =>
    patch({ selectedId: id, isEditing: id === 'new' || (id !== null && editing), dirty: false, pendingSelection: null })
  const requestSelect = (id: string | null, { editing = false }: { editing?: boolean } = {}) => {
    if (id === state.selectedId && (id === 'new' || editing === state.isEditing)) {
      return
    }
    if (state.dirty) {
      patch({ pendingSelection: { id, editing } })
      return
    }
    select(id, { editing })
  }
  useConsumeNavState(openItemStateKey, (itemId) => requestSelect(itemId))

  return {
    ...state,
    /** A create panel is open: `new`, or a `new-…` step such as the add-domain form. */
    isCreating: state.selectedId !== null && isCreatingId(state.selectedId),
    patch,
    select,
    requestSelect,
    /** Close the panel; from an edit form, back to the item's view instead, as Skills does. */
    close: () =>
      state.isEditing && state.selectedId !== null && !isCreatingId(state.selectedId)
        ? requestSelect(state.selectedId)
        : requestSelect(null),
    /** Open `id`'s edit form. */
    edit: (id: string) => requestSelect(id, { editing: true }),
    /** Leave the edit form for the item's view panel, or close the panel when creating. */
    cancelEdit: () => requestSelect(state.selectedId === 'new' ? null : state.selectedId),
  }
}
export type ResourcePageState = ReturnType<typeof useResourcePageState>
