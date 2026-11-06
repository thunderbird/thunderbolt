/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { createElement, StrictMode } from 'react'
import { useAuthAttempt } from './use-auth-attempt'

describe('auth attempt ownership', () => {
  it('aborts pending work on cancel, isolates its replacement, and aborts that on unmount', () => {
    const { result, unmount } = renderHook(useAuthAttempt, {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    })
    const first = result.current.begin()!
    expect(first.signal.aborted).toBe(false)
    expect(result.current.begin()).toBeNull()
    act(() => expect(result.current.cancel()).toBe(true))
    expect(first.signal.aborted).toBe(true)
    const next = result.current.begin()!
    first.finish()
    expect(next.isCurrent()).toBe(true)
    expect(next.signal.aborted).toBe(false)
    unmount()
    expect(next.signal.aborted).toBe(true)
    expect(next.isCurrent()).toBe(false)
  })

  it('cannot undo accepted authentication, and lets housekeeping finish after unmount', () => {
    const { result, unmount } = renderHook(useAuthAttempt)
    const attempt = result.current.begin()!
    attempt.commit()
    expect(attempt.isCommitted()).toBe(true)
    expect(result.current.cancel()).toBe(false)
    expect(attempt.signal.aborted).toBe(false)
    attempt.finish()
    expect(result.current.begin()).toBeNull()
    expect(result.current.cancel()).toBe(false)
    unmount()
    expect(attempt.signal.aborted).toBe(false)
  })
})
