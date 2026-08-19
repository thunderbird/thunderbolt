/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  appVersionUnsupported,
  handleAppVersionUnsupported,
  isAppVersionBlocked,
  resetAppVersionBlockedForTesting,
} from './app-version-unsupported'

const originalDispatch = window.dispatchEvent

describe('handleAppVersionUnsupported', () => {
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    resetAppVersionBlockedForTesting()
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
  })

  it('dispatches app_version_unsupported with the min version on a 426 status', () => {
    const handled = handleAppVersionUnsupported(426, { minAppVersion: '2.0.0' })

    expect(handled).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe(appVersionUnsupported)
    expect(event.detail).toEqual({ minAppVersion: '2.0.0' })
  })

  it('dispatches when the body carries the APP_VERSION_UNSUPPORTED code regardless of status', () => {
    const handled = handleAppVersionUnsupported(400, { code: 'APP_VERSION_UNSUPPORTED', minAppVersion: '3.1.0' })

    expect(handled).toBe(true)
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ minAppVersion: '3.1.0' })
  })

  it('dispatches with an undefined min version when the body omits it', () => {
    const handled = handleAppVersionUnsupported(426)

    expect(handled).toBe(true)
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ minAppVersion: undefined })
  })

  it('returns false and does not dispatch for unrelated statuses', () => {
    expect(handleAppVersionUnsupported(401)).toBe(false)
    expect(handleAppVersionUnsupported(500, { code: 'INTERNAL' })).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  describe('version-block latch', () => {
    it('is not blocked before any 426', () => {
      expect(isAppVersionBlocked()).toBe(false)
    })

    it('latches synchronously on a 426, before the event is dispatched', () => {
      // The sync layer reads the latch, not the event, so it must already be set
      // by the time any listener (or an in-flight connect) observes the block.
      dispatchSpy = mock(() => {
        expect(isAppVersionBlocked()).toBe(true)
        return true
      })
      window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent

      handleAppVersionUnsupported(426, { minAppVersion: '2.0.0' })

      expect(dispatchSpy).toHaveBeenCalledTimes(1)
      expect(isAppVersionBlocked()).toBe(true)
    })

    it('latches on the APP_VERSION_UNSUPPORTED code regardless of status', () => {
      handleAppVersionUnsupported(400, { code: 'APP_VERSION_UNSUPPORTED' })
      expect(isAppVersionBlocked()).toBe(true)
    })

    it('stays latched for the rest of the session once set', () => {
      handleAppVersionUnsupported(426)
      expect(handleAppVersionUnsupported(200)).toBe(false)
      expect(isAppVersionBlocked()).toBe(true)
    })

    it('does not latch for unrelated failures', () => {
      handleAppVersionUnsupported(401)
      handleAppVersionUnsupported(503, { code: 'SERVICE_UNAVAILABLE' })
      expect(isAppVersionBlocked()).toBe(false)
    })
  })
})
