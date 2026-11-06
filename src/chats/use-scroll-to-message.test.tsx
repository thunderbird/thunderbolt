/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { scrollToMessageStateKey } from './scroll-to-message-intent'
import { useScrollToMessage } from './use-scroll-to-message'

const noMessages = [] as ThunderboltUIMessage[]

/** Builds a detached scroll container, optionally holding a message node with the given id. */
const makeContainer = (messageId?: string): HTMLDivElement => {
  const container = document.createElement('div')
  if (messageId) {
    const message = document.createElement('div')
    message.setAttribute('data-message-id', messageId)
    container.appendChild(message)
  }
  return container
}

// Router state is the deep-link channel: mounting under this pathname/state is
// equivalent to the palette navigating to the chat with a target message id.
const wrapperWithState = (messageId?: string) => {
  const state = messageId ? { [scrollToMessageStateKey]: messageId } : {}
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[{ pathname: '/chats/thread-1', state }]}>{children}</MemoryRouter>
  )
}

/** Flush the queued consume microtask, then run the rAF wait-for-element retry loop. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('useScrollToMessage', () => {
  afterEach(() => {
    cleanup()
  })

  it('scrolls to and flashes the target once the element is present', async () => {
    const scrollToMessage = mock(() => true)
    const container = makeContainer('msg-1')

    renderHook(() => useScrollToMessage({ scrollContainer: container, scrollToMessage, messages: noMessages }), {
      wrapper: wrapperWithState('msg-1'),
    })

    await settle()

    expect(scrollToMessage).toHaveBeenCalledTimes(1)
    expect(scrollToMessage).toHaveBeenCalledWith('msg-1')

    const element = container.querySelector('[data-message-id="msg-1"]')!
    expect(element.classList.contains('animate-message-flash')).toBe(true)

    // The flash class is cleared when the animation ends.
    act(() => {
      element.dispatchEvent(new Event('animationend'))
    })
    expect(element.classList.contains('animate-message-flash')).toBe(false)
  })

  it('does not scroll to bottom when the target is not yet mounted (bounded retry gives up)', async () => {
    const scrollToMessage = mock(() => true)
    const container = makeContainer() // no matching node — element never appears

    renderHook(() => useScrollToMessage({ scrollContainer: container, scrollToMessage, messages: noMessages }), {
      wrapper: wrapperWithState('msg-missing'),
    })

    await settle()

    // Guards the scrollToElement fallback-to-bottom trap: never called on a miss.
    expect(scrollToMessage).not.toHaveBeenCalled()
  })

  it('waits across frames until a late-mounting element appears, then scrolls', async () => {
    const scrollToMessage = mock(() => true)
    const container = makeContainer() // starts empty

    renderHook(() => useScrollToMessage({ scrollContainer: container, scrollToMessage, messages: noMessages }), {
      wrapper: wrapperWithState('late-msg'),
    })

    // Consume the deep link and let a few retry frames run against the empty container.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await getClock().tickAsync(48) // ~3 frames at 60fps
    })
    expect(scrollToMessage).not.toHaveBeenCalled()

    // The message node mounts a bit later; the retry loop then finds it.
    const message = document.createElement('div')
    message.setAttribute('data-message-id', 'late-msg')
    container.appendChild(message)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(scrollToMessage).toHaveBeenCalledTimes(1)
    expect(scrollToMessage).toHaveBeenCalledWith('late-msg')
  })

  it('does nothing when there is no deep-link state', async () => {
    const scrollToMessage = mock(() => true)
    const container = makeContainer('msg-1')

    renderHook(() => useScrollToMessage({ scrollContainer: container, scrollToMessage, messages: noMessages }), {
      wrapper: wrapperWithState(),
    })

    await settle()

    expect(scrollToMessage).not.toHaveBeenCalled()
  })

  it('does not throw or scroll while the container is null', async () => {
    const scrollToMessage = mock(() => true)

    renderHook(() => useScrollToMessage({ scrollContainer: null, scrollToMessage, messages: noMessages }), {
      wrapper: wrapperWithState('msg-1'),
    })

    await settle()

    expect(scrollToMessage).not.toHaveBeenCalled()
  })
})
