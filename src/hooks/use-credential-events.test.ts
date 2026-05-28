/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, spyOn } from 'bun:test'
import { useCredentialEvents, showRevokedDeviceModalEvent } from './use-credential-events'

describe('useCredentialEvents', () => {
  const dispatchRevokedDeviceEvent = () => window.dispatchEvent(new CustomEvent(showRevokedDeviceModalEvent))

  it('returns revokedDeviceOpen as false initially', () => {
    const { result } = renderHook(() => useCredentialEvents())
    expect(result.current.revokedDeviceOpen).toBe(false)
  })

  it('sets revokedDeviceOpen to true when show_revoked_device_modal event is dispatched', () => {
    const { result } = renderHook(() => useCredentialEvents())

    act(() => {
      dispatchRevokedDeviceEvent()
    })

    expect(result.current.revokedDeviceOpen).toBe(true)
  })

  it('responds to multiple event dispatches', () => {
    const { result } = renderHook(() => useCredentialEvents())

    act(() => {
      dispatchRevokedDeviceEvent()
    })
    expect(result.current.revokedDeviceOpen).toBe(true)

    act(() => {
      dispatchRevokedDeviceEvent()
    })
    expect(result.current.revokedDeviceOpen).toBe(true)
  })

  it('removes event listener on unmount', () => {
    const addSpy = spyOn(window, 'addEventListener')
    const removeSpy = spyOn(window, 'removeEventListener')

    const { unmount } = renderHook(() => useCredentialEvents())

    expect(addSpy).toHaveBeenCalledWith(showRevokedDeviceModalEvent, expect.any(Function))

    unmount()

    expect(removeSpy).toHaveBeenCalledWith(showRevokedDeviceModalEvent, expect.any(Function))

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
