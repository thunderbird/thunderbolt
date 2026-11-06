/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'

type MenuState = { targetKey: string | undefined; surface: 'closed' | 'picker' | 'privacy' }

/** Coordinate the two surfaces and discard a disclosure when its transport changes. */
export const useEffortSelectorMenu = (targetKey: string | undefined) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [state, setState] = useState<MenuState>({ targetKey, surface: 'closed' })
  if (state.targetKey !== targetKey) {
    setState({ targetKey, surface: state.surface === 'privacy' ? 'closed' : state.surface })
  }
  return {
    triggerRef,
    open: state.surface === 'picker',
    privacyOpen: state.targetKey === targetKey && state.surface === 'privacy',
    setOpen: (open: boolean) => setState({ targetKey, surface: open ? 'picker' : 'closed' }),
    setPrivacyOpen: (open: boolean) => setState({ targetKey, surface: open ? 'privacy' : 'closed' }),
  }
}
