/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { appVersionHeader, isAppVersionUnsupported, isVersionBelowMinimum } from './app-version'
import { handleAppVersionUnsupported, resetAppVersionBlockedForTesting } from './app-version-unsupported'

const env = import.meta.env as Record<string, unknown>

describe('appVersionHeader', () => {
  let saved: unknown

  beforeEach(() => {
    saved = env.VITE_APP_VERSION
  })

  afterEach(() => {
    env.VITE_APP_VERSION = saved
  })

  it('returns the X-App-Version header when VITE_APP_VERSION is set', () => {
    env.VITE_APP_VERSION = '1.2.3'
    expect(appVersionHeader()).toEqual({ 'X-App-Version': '1.2.3' })
  })

  it('returns an empty object when VITE_APP_VERSION is unset', () => {
    env.VITE_APP_VERSION = undefined
    expect(appVersionHeader()).toEqual({})
  })

  it('returns an empty object for an empty-string version', () => {
    env.VITE_APP_VERSION = ''
    expect(appVersionHeader()).toEqual({})
  })
})

describe('isVersionBelowMinimum', () => {
  it('is true when the build is older than the minimum', () => {
    expect(isVersionBelowMinimum('0.1.123', '0.1.124')).toBe(true)
    expect(isVersionBelowMinimum('0.9.0', '1.0.0')).toBe(true)
  })

  it('is false at or above the minimum', () => {
    expect(isVersionBelowMinimum('0.1.124', '0.1.124')).toBe(false)
    expect(isVersionBelowMinimum('1.0.0', '0.1.124')).toBe(false)
  })

  it('does not enforce when either side is missing', () => {
    expect(isVersionBelowMinimum(undefined, '99.0.0')).toBe(false)
    expect(isVersionBelowMinimum('0.1.123', undefined)).toBe(false)
    expect(isVersionBelowMinimum('0.1.123', '')).toBe(false)
  })
})

describe('isAppVersionUnsupported', () => {
  let saved: unknown
  // The config store is a module singleton shared with every other suite in the
  // process — restore what was there rather than clearing it.
  let savedConfig: ReturnType<typeof useConfigStore.getState>['config']

  beforeEach(() => {
    saved = env.VITE_APP_VERSION
    savedConfig = useConfigStore.getState().config
    resetAppVersionBlockedForTesting()
    useConfigStore.setState({ config: {} })
  })

  afterEach(() => {
    env.VITE_APP_VERSION = saved
    resetAppVersionBlockedForTesting()
    useConfigStore.setState({ config: savedConfig })
  })

  it('is false with no minimum configured and no 426 seen', () => {
    env.VITE_APP_VERSION = '0.1.123'
    expect(isAppVersionUnsupported()).toBe(false)
  })

  it('is true from the persisted config minimum alone, before any 426', () => {
    // The boot case: a returning stale client must know it is blocked without
    // having to be rejected first, or sync would connect and start queueing.
    env.VITE_APP_VERSION = '0.1.123'
    useConfigStore.setState({ config: { minAppVersion: '0.1.124' } })
    expect(isAppVersionUnsupported()).toBe(true)
  })

  it('is true from a latched 426 even when config carries no minimum', () => {
    env.VITE_APP_VERSION = '0.1.123'
    handleAppVersionUnsupported(426)
    expect(isAppVersionUnsupported()).toBe(true)
  })

  it('is false for a build at or above the configured minimum', () => {
    env.VITE_APP_VERSION = '0.1.124'
    useConfigStore.setState({ config: { minAppVersion: '0.1.124' } })
    expect(isAppVersionUnsupported()).toBe(false)
  })
})
