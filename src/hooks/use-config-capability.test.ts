/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectBuiltInAgentEnabled, selectMinimalMode, useConfigStore } from '@/api/config-store'
import { clearAuthToken, setAuthToken } from '@/lib/auth-token'
import { clearCachedSession } from '@/lib/session-cache'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useConfigCapability } from './use-config-capability'

const originalConfig = useConfigStore.getState().config

describe('useConfigCapability', () => {
  afterEach(() => {
    cleanup()
    clearAuthToken()
    clearCachedSession()
    useConfigStore.setState({ config: originalConfig })
  })

  it('updates on optional-server sign-in and expiry without replacing its config', () => {
    clearAuthToken()
    clearCachedSession()
    useLocalSettingsStore.setState({ cloudUrl: 'https://optional.example/v1', localMode: true })
    useConfigStore.setState({ config: { authMode: 'oidc', minimalMode: true, builtInAgentEnabled: false } })
    const { result } = renderHook(() => ({
      minimal: useConfigCapability(selectMinimalMode),
      builtIn: useConfigCapability(selectBuiltInAgentEnabled),
    }))

    expect(result.current).toEqual({ minimal: false, builtIn: true })
    act(() => setAuthToken('signed-in'))
    expect(result.current).toEqual({ minimal: true, builtIn: false })
    act(clearAuthToken)
    expect(result.current).toEqual({ minimal: false, builtIn: true })
    expect(useConfigStore.getState().config.authMode).toBe('oidc')
  })
})
