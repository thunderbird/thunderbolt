/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'

import { useSidePaneFit } from './use-chat-split'

type Props = { splitFits: boolean; isChatOpen: boolean; isAsideOpen: boolean }

const setup = (initial: Props) => {
  const closeChat = mock(() => {})
  const { result, rerender } = renderHook((props: Props) => useSidePaneFit({ ...props, closeChat }), {
    initialProps: initial,
  })
  return { closeChat, result, rerender }
}

describe('useSidePaneFit', () => {
  it('shows the pane while the split fits and something is open in it', () => {
    const { result } = setup({ splitFits: true, isChatOpen: true, isAsideOpen: false })

    expect(result.current).toBe(true)
  })

  it('closes the chat when the split stops fitting', () => {
    const { closeChat, result, rerender } = setup({ splitFits: true, isChatOpen: true, isAsideOpen: false })

    rerender({ splitFits: false, isChatOpen: true, isAsideOpen: false })

    expect(closeChat).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(false)
  })

  /*
   * The aside's content belongs to the content view, which outlives the route,
   * so narrowing the window must not be what discards an artifact opened elsewhere.
   */
  it('withholds an open aside while the split does not fit and shows it again once it does', () => {
    const { closeChat, result, rerender } = setup({ splitFits: true, isChatOpen: false, isAsideOpen: true })

    rerender({ splitFits: false, isChatOpen: false, isAsideOpen: true })

    expect(result.current).toBe(false)

    rerender({ splitFits: true, isChatOpen: false, isAsideOpen: true })

    expect(result.current).toBe(true)
    expect(closeChat).not.toHaveBeenCalled()
  })
})
