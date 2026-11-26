/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { createElement, StrictMode, useEffect } from 'react'
import { createAsyncAttempt, useAsyncAttempt } from './use-async-attempt'

describe('async attempt lane', () => {
  it('rejects overlap, invalidates cancelled results, and isolates replacement cleanup', () => {
    const lane = createAsyncAttempt()
    const first = lane.begin()!
    expect(lane.begin()).toBeNull()
    lane.cancel()
    const replacement = lane.begin()!
    expect(first.isCurrent()).toBe(false)
    first.finish()
    expect(replacement.isCurrent()).toBe(true)
    expect(lane.begin()).toBeNull()
    replacement.finish()
    expect(lane.begin()).not.toBeNull()
  })

  it('preserves an in-flight mount operation across Strict Mode effect replay', async () => {
    const response = Promise.withResolvers<void>()
    const start = mock()
    const complete = mock()
    renderHook(
      () => {
        const lane = useAsyncAttempt()
        useEffect(() => {
          const run = async () => {
            const attempt = lane.begin()
            if (!attempt) {
              return
            }
            start()
            await response.promise
            if (attempt.isCurrent()) {
              complete()
            }
            attempt.finish()
          }
          void run()
        }, [lane])
      },
      { wrapper: ({ children }) => createElement(StrictMode, null, children) },
    )
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => response.resolve())
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('rejects new work and late results after unmount', () => {
    const { result, unmount } = renderHook(useAsyncAttempt)
    const lane = result.current
    const pending = lane.begin()!
    unmount()
    expect(pending.isCurrent()).toBe(false)
    expect(lane.begin()).toBeNull()
    pending.finish()
    expect(lane.begin()).toBeNull()
  })
})
