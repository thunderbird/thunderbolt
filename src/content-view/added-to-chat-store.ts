/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'

/**
 * Whether the "Added to chat" confirmation is showing.
 *
 * A store rather than state in the content view, because the view that raises
 * the toast closes in the same gesture and would take the toast with it.
 * `shownCount` lets a repeat add restart the timer of a toast already open.
 */
type AddedToChatStore = {
  isOpen: boolean
  shownCount: number
  show: () => void
  dismiss: () => void
}

export const useAddedToChatStore = create<AddedToChatStore>((set) => ({
  isOpen: false,
  shownCount: 0,
  show: () => set((state) => ({ isOpen: true, shownCount: state.shownCount + 1 })),
  dismiss: () => set({ isOpen: false }),
}))
