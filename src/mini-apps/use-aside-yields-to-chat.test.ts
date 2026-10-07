/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'

import { useAsideYieldsToChat } from './use-aside-yields-to-chat'

type Props = { isChatOpen: boolean; isAsideOpen: boolean }

const setup = (initial: Props) => {
  const closeAside = mock(() => {})
  const { rerender } = renderHook((props: Props) => useAsideYieldsToChat({ ...props, closeAside }), {
    initialProps: initial,
  })
  return { closeAside, rerender }
}

describe('useAsideYieldsToChat', () => {
  it('dismisses an aside when the chat opens under it', () => {
    const { closeAside, rerender } = setup({ isChatOpen: false, isAsideOpen: true })

    rerender({ isChatOpen: true, isAsideOpen: true })

    expect(closeAside).toHaveBeenCalledTimes(1)
  })

  /*
   * The other direction is the whole point of layering: an aside opened from
   * the conversation sits over it, and the conversation waits underneath.
   */
  it('leaves an aside that opens over an already-open chat alone', () => {
    const { closeAside, rerender } = setup({ isChatOpen: true, isAsideOpen: false })

    rerender({ isChatOpen: true, isAsideOpen: true })
    rerender({ isChatOpen: true, isAsideOpen: true })

    expect(closeAside).not.toHaveBeenCalled()
  })

  // An app chat opened from the nav sidebar while an aside was up elsewhere.
  it('treats mounting with both open as the chat arriving', () => {
    const { closeAside } = setup({ isChatOpen: true, isAsideOpen: true })

    expect(closeAside).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a chat that opens with no aside up', () => {
    const { closeAside, rerender } = setup({ isChatOpen: false, isAsideOpen: false })

    rerender({ isChatOpen: true, isAsideOpen: false })

    expect(closeAside).not.toHaveBeenCalled()
  })

  it('fires once per opening, not on every render while open', () => {
    const { closeAside, rerender } = setup({ isChatOpen: false, isAsideOpen: true })

    rerender({ isChatOpen: true, isAsideOpen: true })
    // The host closes the aside; later another one opens over the live chat.
    rerender({ isChatOpen: true, isAsideOpen: false })
    rerender({ isChatOpen: true, isAsideOpen: true })

    expect(closeAside).toHaveBeenCalledTimes(1)
  })
})
