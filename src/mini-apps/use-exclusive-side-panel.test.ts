/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Only one right-hand panel at a time, and specifically without the cycle.
 *
 * The naive version of this rule — close the chat whenever the aside is open —
 * breaks the aside's own "Ask about this", which opens the chat to receive the
 * passage. The last test here is the one that catches it.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'

import { useExclusiveSidePanel } from './use-exclusive-side-panel'

const setup = (initial: { isChatOpen: boolean; isAsideOpen: boolean }) => {
  const closeChat = mock(() => {})
  const closeAside = mock(() => {})
  const { rerender } = renderHook(
    (props: { isChatOpen: boolean; isAsideOpen: boolean }) =>
      useExclusiveSidePanel({ ...props, closeChat, closeAside }),
    { initialProps: initial },
  )
  return { closeChat, closeAside, rerender }
}

describe('useExclusiveSidePanel', () => {
  it('leaves a lone panel alone', () => {
    const { closeChat, closeAside } = setup({ isChatOpen: true, isAsideOpen: false })

    expect(closeChat).not.toHaveBeenCalled()
    expect(closeAside).not.toHaveBeenCalled()
  })

  it('closes the chat when the aside opens over it', () => {
    const { closeChat, closeAside, rerender } = setup({ isChatOpen: true, isAsideOpen: false })

    rerender({ isChatOpen: true, isAsideOpen: true })

    expect(closeChat).toHaveBeenCalledTimes(1)
    expect(closeAside).not.toHaveBeenCalled()
  })

  it('closes the aside when the chat opens over it', () => {
    const { closeChat, closeAside, rerender } = setup({ isChatOpen: false, isAsideOpen: true })

    rerender({ isChatOpen: true, isAsideOpen: true })

    expect(closeAside).toHaveBeenCalledTimes(1)
    expect(closeChat).not.toHaveBeenCalled()
  })

  it('does not fire again while the same panel stays open', () => {
    const { closeChat, rerender } = setup({ isChatOpen: true, isAsideOpen: false })

    rerender({ isChatOpen: true, isAsideOpen: true })
    // The host closes the chat, so the next render arrives with it already shut.
    rerender({ isChatOpen: false, isAsideOpen: true })
    rerender({ isChatOpen: false, isAsideOpen: true })

    expect(closeChat).toHaveBeenCalledTimes(1)
  })

  /*
   * The cycle. "Ask about this" in the aside attaches a passage and opens the
   * chat; a rule that closed the chat whenever the aside was open would shut it
   * again and drop the passage. Here the chat is the newcomer, so the aside
   * yields and the chat is left alone.
   */
  it('lets the aside hand a passage to the chat without closing it again', () => {
    const { closeChat, closeAside, rerender } = setup({ isChatOpen: false, isAsideOpen: true })

    rerender({ isChatOpen: true, isAsideOpen: true })
    rerender({ isChatOpen: true, isAsideOpen: false })

    expect(closeAside).toHaveBeenCalledTimes(1)
    expect(closeChat).not.toHaveBeenCalled()
  })
})
