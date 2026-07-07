/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useOnScreen } from './use-on-screen'

describe('useOnScreen', () => {
  let restoreIntersectionObserver: () => void
  beforeEach(() => {
    restoreIntersectionObserver = mockIntersectionObserver(true)
  })
  afterEach(() => {
    restoreIntersectionObserver()
  })

  it('activates once the element scrolls into view', () => {
    const ref = { current: document.createElement('div') }
    const { result } = renderHook(() => useOnScreen(ref))
    expect(result.current).toBe(true)
  })

  it('assumes visible when there is no element to observe', () => {
    const ref = { current: null }
    const { result } = renderHook(() => useOnScreen(ref))
    expect(result.current).toBe(true)
  })
})
