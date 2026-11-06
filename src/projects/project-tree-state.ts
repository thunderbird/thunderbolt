/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type ProjectTreeState = { activeId: string | null; expanded: ReadonlySet<string> }
type ProjectTreeAction = { type: 'toggle'; id: string } | { type: 'navigate'; id: string | null }

/** Navigation reveals the selected chat's project; manual toggles remain independent. */
export const projectTreeReducer = (state: ProjectTreeState, action: ProjectTreeAction): ProjectTreeState => {
  const expanded = new Set(state.expanded)
  if (action.type === 'navigate') {
    if (action.id) {
      expanded.add(action.id)
    }
    return { activeId: action.id, expanded }
  }
  if (expanded.has(action.id)) {
    expanded.delete(action.id)
  } else {
    expanded.add(action.id)
  }
  return { ...state, expanded }
}
