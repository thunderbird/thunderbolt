/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useEffortSelectorMenu } from './use-effort-selector-menu'

describe('effort selector surfaces', () => {
  it('opens privacy by closing the picker and closes both on dismiss', () => {
    const { result } = renderHook(() => useEffortSelectorMenu('tinfoil:user'))
    act(() => result.current.setOpen(true))
    expect(result.current.open).toBe(true)
    act(() => result.current.setPrivacyOpen(true))
    expect(result.current.open).toBe(false)
    expect(result.current.privacyOpen).toBe(true)
    act(() => result.current.setPrivacyOpen(false))
    expect(result.current.privacyOpen).toBe(false)
    act(() => result.current.setOpen(true))
    act(() => result.current.setOpen(false))
    expect(result.current.open).toBe(false)
  })

  it('closes privacy when the transport changes and never revives it on returning', () => {
    const { result, rerender } = renderHook(({ target }) => useEffortSelectorMenu(target), {
      initialProps: { target: 'tinfoil:user' as string | undefined },
    })
    act(() => result.current.setPrivacyOpen(true))
    rerender({ target: undefined })
    expect(result.current.privacyOpen).toBe(false)
    rerender({ target: 'tinfoil:user' })
    expect(result.current.privacyOpen).toBe(false)
    act(() => result.current.setPrivacyOpen(true))
    rerender({ target: 'tinfoil:system:https://other-backend.example' })
    expect(result.current.privacyOpen).toBe(false)
  })

  it('keeps model selection open while switching providers', () => {
    const { result, rerender } = renderHook(({ target }) => useEffortSelectorMenu(target), {
      initialProps: { target: 'tinfoil:user' },
    })
    act(() => result.current.setOpen(true))
    rerender({ target: 'unsupported:custom' })
    expect(result.current.open).toBe(true)
  })
})
