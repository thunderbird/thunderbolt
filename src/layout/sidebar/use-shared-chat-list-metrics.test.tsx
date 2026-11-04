/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, render } from '@testing-library/react'
import { expect, it, mock } from 'bun:test'
import { useRef, type RefObject } from 'react'
import { useSharedChatListMetrics } from './use-shared-chat-list-metrics'

it('updates virtual row offsets when projects expand above a scrolled recent list', () => {
  const original = globalThis.ResizeObserver
  let measure = () => {}
  let listTop = 250
  const disconnect = mock(() => {})
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      measure = () => callback([], this)
    }
    observe(target: Element) {
      expect(target).toBeInstanceOf(Element)
    }
    unobserve() {}
    disconnect = disconnect
  }

  const List = ({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) => {
    const metrics = useSharedChatListMetrics(scrollRef)
    return (
      <div>
        <div
          ref={(element) => {
            metrics.listRef.current = element
            if (element) {
              element.getBoundingClientRect = () => ({ top: listTop }) as DOMRect
            }
          }}
        />
        <output>{metrics.startMargin}</output>
      </div>
    )
  }
  const Fixture = () => {
    const scrollRef = useRef<HTMLDivElement>(null)
    return (
      <div
        ref={(element) => {
          scrollRef.current = element
          if (element) {
            element.getBoundingClientRect = () => ({ top: 50 }) as DOMRect
            element.scrollTop = 100
          }
        }}
      >
        <List scrollRef={scrollRef} />
      </div>
    )
  }
  try {
    const view = render(<Fixture />)
    expect(view.getByRole('status').textContent).toBe('300')
    act(() => {
      listTop = 650
      measure()
    })
    expect(view.getByRole('status').textContent).toBe('700')
    act(() => {
      listTop = 150
      measure()
    })
    expect(view.getByRole('status').textContent).toBe('200')
    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  } finally {
    globalThis.ResizeObserver = original
  }
})
