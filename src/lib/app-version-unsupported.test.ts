/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { appVersionUnsupported, handleAppVersionUnsupported } from './app-version-unsupported'

const originalDispatch = window.dispatchEvent

describe('handleAppVersionUnsupported', () => {
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
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
})
