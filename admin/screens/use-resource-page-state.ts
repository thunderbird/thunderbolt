/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useReducer } from 'react'
import { useSearchParams } from 'react-router'

type PageState = { dirty: boolean; pendingSelection: { id: string | null } | null; removeId: string | null }

/** Keep selected forms deep-linkable and protect local drafts when selecting or closing a form. */
export const useResourcePageState = () => {
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('edit')
  const [state, patch] = useReducer((current: PageState, update: Partial<PageState>) => ({ ...current, ...update }), {
    dirty: false,
    pendingSelection: null,
    removeId: null,
  })
  const select = (id: string | null) => {
    setParams(id === null ? {} : { edit: id })
    patch({ dirty: false, pendingSelection: null })
  }
  const requestSelect = (id: string | null) => {
    if (id === selectedId) {
      return
    }
    if (state.dirty) {
      patch({ pendingSelection: { id } })
      return
    }
    select(id)
  }
  return { ...state, selectedId, patch, select, requestSelect, close: () => requestSelect(null) }
}
export type ResourcePageState = ReturnType<typeof useResourcePageState>
