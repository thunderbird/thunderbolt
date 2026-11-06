/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { appVersionUnsupported } from '@/lib/app-version-unsupported'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useAppVersionUnsupportedListener } from './use-app-version-unsupported-listener'

const resetStore = () => {
  useConfigStore.setState({ config: {}, forceUpgrade: undefined, forceUpgradeMinVersion: undefined })
  localStorage.removeItem('thunderbolt-config')
}

const dispatchUnsupported = (minAppVersion?: string) =>
  window.dispatchEvent(new CustomEvent(appVersionUnsupported, { detail: { minAppVersion } }))

describe('useAppVersionUnsupportedListener', () => {
  beforeEach(resetStore)

  afterEach(() => {
    cleanup()
    resetStore()
  })

  it('flips forceUpgrade and records the min version on the event', () => {
    renderHook(() => useAppVersionUnsupportedListener())

    act(() => dispatchUnsupported('4.5.6'))

    expect(useConfigStore.getState().forceUpgrade).toBe(true)
    expect(useConfigStore.getState().forceUpgradeMinVersion).toBe('4.5.6')
  })

  it('flips forceUpgrade even when the event omits a min version', () => {
    renderHook(() => useAppVersionUnsupportedListener())

    act(() => dispatchUnsupported())

    expect(useConfigStore.getState().forceUpgrade).toBe(true)
    expect(useConfigStore.getState().forceUpgradeMinVersion).toBeUndefined()
  })

  it('stops responding after unmount', () => {
    const { unmount } = renderHook(() => useAppVersionUnsupportedListener())
    unmount()

    act(() => dispatchUnsupported('9.9.9'))

    expect(useConfigStore.getState().forceUpgrade).toBeUndefined()
  })
})
