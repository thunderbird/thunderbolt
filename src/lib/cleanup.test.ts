/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'

const calls: string[] = []

const broadcastDbLifecycle = mock((event: { kind: string }) => {
  calls.push(`broadcast:${event.kind}`)
})

const setSyncEnabled = mock(async (enabled: boolean) => {
  calls.push(`setSyncEnabled:${enabled}`)
})

const resetDatabase = mock(async () => {
  calls.push('resetDatabase')
})

const deleteDbFile = mock(async (filename: string) => {
  calls.push(`deleteDbFile:${filename}`)
})

// Include the full surface so these mock.module calls don't shadow real exports for other
// test files that load after this one (docs/development/testing.md §65).
const realDbLifecycleBroadcast = await import('@/db/db-lifecycle-broadcast')
mock.module('@/db/db-lifecycle-broadcast', () => ({
  ...realDbLifecycleBroadcast,
  broadcastDbLifecycle,
  setupDbLifecycleReloadOnRemoteClose: () => {},
}))

const realDatabase = await import('@/db/database')
mock.module('@/db/database', () => ({
  ...realDatabase,
  resetDatabase,
}))

const realPowersync = await import('@/db/powersync')
mock.module('@/db/powersync', () => ({
  ...realPowersync,
  setSyncEnabled,
}))

const realFs = await import('@/lib/fs')
mock.module('@/lib/fs', () => ({
  ...realFs,
  deleteDbFile,
}))

// Import after module mocks so the SUT picks them up.
const { clearLocalData, signOutAndWipe } = await import('./cleanup')

const serverId = '00000000-0000-0000-0000-0000000000aa'

// Injected deps — passed directly to clearLocalData/signOutAndWipe rather than
// mocking shared modules globally, per the testing docs DI guideline.
const clearAuthToken = mock(() => {
  calls.push('clearAuthToken')
})
const clearDeviceId = mock(() => {
  calls.push('clearDeviceId')
})
const handleFullWipe = mock(async () => {
  calls.push('handleFullWipe')
})

const deps = { clearAuthToken, clearDeviceId, handleFullWipe }

describe('clearLocalData', () => {
  beforeEach(() => {
    calls.length = 0
    broadcastDbLifecycle.mockClear()
    setSyncEnabled.mockClear()
    resetDatabase.mockClear()
    deleteDbFile.mockClear()
    clearAuthToken.mockClear()
    clearDeviceId.mockClear()
    handleFullWipe.mockClear()
    useTrustDomainRegistry.setState({
      servers: { [serverId]: { serverId, cloudUrl: 'http://test.local' } },
      activeTrustDomain: { kind: 'server', serverId },
    })
  })

  afterEach(() => {
    useTrustDomainRegistry.setState({ servers: {}, activeTrustDomain: undefined })
  })

  it('runs the server-mode wipe sequence in order', async () => {
    await clearLocalData(deps)

    expect(calls).toEqual([
      'setSyncEnabled:false',
      'broadcast:db-closing',
      'resetDatabase',
      `deleteDbFile:server-${serverId}.db`,
      'broadcast:db-deleted',
      'clearAuthToken',
      'clearDeviceId',
      'handleFullWipe',
    ])
  })

  it('resets local-settings to their defaults', async () => {
    useLocalSettingsStore.setState({ theme: 'dark', debugPosthog: true, hapticsEnabled: false })

    await clearLocalData(deps)

    const state = useLocalSettingsStore.getState()
    expect(state.theme).toBe(initialLocalSettings.theme)
    expect(state.debugPosthog).toBe(initialLocalSettings.debugPosthog)
    expect(state.hapticsEnabled).toBe(initialLocalSettings.hapticsEnabled)
  })

  it('skips encryption-key wipe in standalone mode', async () => {
    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })

    await clearLocalData(deps)

    expect(calls).toContain('deleteDbFile:standalone.db')
    expect(calls).not.toContain('handleFullWipe')
  })

  it('continues through the sequence when a step throws', async () => {
    setSyncEnabled.mockRejectedValueOnce(new Error('powersync hiccup'))
    resetDatabase.mockRejectedValueOnce(new Error('close failed'))
    handleFullWipe.mockRejectedValueOnce(new Error('IDB gone'))

    await clearLocalData(deps)

    // setSyncEnabled, resetDatabase, and handleFullWipe rejected — they don't appear
    // in `calls` because the mocks above only push from the success path. We're
    // verifying the surrounding steps still ran, i.e. failure is non-fatal.
    expect(calls).toContain('broadcast:db-closing')
    expect(calls).toContain(`deleteDbFile:server-${serverId}.db`)
    expect(calls).toContain('broadcast:db-deleted')
    expect(calls).toContain('clearAuthToken')
    expect(calls).toContain('clearDeviceId')
  })

  it('skips all broadcast + file-delete steps when no active trust domain', async () => {
    useTrustDomainRegistry.setState({ activeTrustDomain: undefined })

    await clearLocalData(deps)

    expect(broadcastDbLifecycle).not.toHaveBeenCalled()
    expect(deleteDbFile).not.toHaveBeenCalled()
    expect(calls).toContain('clearAuthToken')
    expect(calls).toContain('clearDeviceId')
  })

  it('clears activeTrustDomain from the registry before broadcasting db-closing', async () => {
    // Regression: reloaded tabs that receive `db-closing` read the persisted
    // registry on boot. If we broadcast first and clear later, those tabs
    // re-resolve to the same server and race resetDatabase/deleteDbFile by
    // reopening the SQLite file (#932 r3369942991). The clear has to land
    // before the broadcast so reloaded tabs see NO_TRUST_DOMAIN → ModePicker.
    let registryAtBroadcast: ReturnType<typeof useTrustDomainRegistry.getState>['activeTrustDomain']
    broadcastDbLifecycle.mockImplementationOnce((event: { kind: string }) => {
      calls.push(`broadcast:${event.kind}`)
      registryAtBroadcast = useTrustDomainRegistry.getState().activeTrustDomain
    })

    await clearLocalData(deps)

    expect(registryAtBroadcast).toBeUndefined()
  })
})

describe('signOutAndWipe', () => {
  const mockReplace = mock()
  const originalLocation = window.location

  beforeEach(() => {
    calls.length = 0
    broadcastDbLifecycle.mockClear()
    setSyncEnabled.mockClear()
    resetDatabase.mockClear()
    deleteDbFile.mockClear()
    clearAuthToken.mockClear()
    clearDeviceId.mockClear()
    handleFullWipe.mockClear()
    mockReplace.mockClear()
    useTrustDomainRegistry.setState({
      servers: { [serverId]: { serverId, cloudUrl: 'http://test.local' } },
      activeTrustDomain: { kind: 'server', serverId },
    })
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, replace: mockReplace },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('calls clearLocalData → signOut → onComplete in that order', async () => {
    const signOut = mock(async () => {
      calls.push('signOut')
    })
    const onComplete = mock(() => {
      calls.push('onComplete')
    })

    await signOutAndWipe({ signOut, onComplete, ...deps })

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('setSyncEnabled:false')
    expect(calls).toContain(`deleteDbFile:server-${serverId}.db`)
    expect(calls[calls.length - 1]).toBe('onComplete')
  })

  it('skips signOut when not provided (revoked-device path)', async () => {
    const onComplete = mock(() => {})

    await signOutAndWipe({ onComplete, ...deps })

    expect(calls[0]).toBe('setSyncEnabled:false')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('still fires onComplete if signOut throws', async () => {
    const signOut = mock(async () => {
      throw new Error('network down')
    })
    const onComplete = mock(() => {})

    await signOutAndWipe({ signOut, onComplete, ...deps })

    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('still fires onComplete if clearLocalData throws (resetDatabase rejects)', async () => {
    resetDatabase.mockRejectedValueOnce(new Error('close failed'))
    const onComplete = mock(() => {})

    await signOutAndWipe({ onComplete, ...deps })

    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('clears credentials AFTER signOut so the server can revoke the session', async () => {
    // Regression: the previous version cleared the auth token inside
    // clearLocalData (before signOut), so the /sign-out HTTP call went out
    // bearer-less and the BE never revoked. Order has to be
    // wipe → signOut → clearAuthToken/clearDeviceId → onComplete.
    const signOut = mock(async () => {
      calls.push('signOut')
    })
    const onComplete = mock(() => {
      calls.push('onComplete')
    })

    await signOutAndWipe({ signOut, onComplete, ...deps })

    const signOutIdx = calls.indexOf('signOut')
    const authTokenIdx = calls.indexOf('clearAuthToken')
    const deviceIdIdx = calls.indexOf('clearDeviceId')
    const onCompleteIdx = calls.indexOf('onComplete')

    expect(signOutIdx).toBeGreaterThan(-1)
    expect(authTokenIdx).toBeGreaterThan(signOutIdx)
    expect(deviceIdIdx).toBeGreaterThan(signOutIdx)
    expect(onCompleteIdx).toBeGreaterThan(authTokenIdx)
    expect(onCompleteIdx).toBeGreaterThan(deviceIdIdx)
  })

  it('still clears credentials on the revoked-device path (no signOut)', async () => {
    // RevokedDeviceModal doesn't pass `signOut` (the server already
    // invalidated the session). The deferred-credential clear still has to
    // run so the local token is wiped.
    const onComplete = mock(() => {})

    await signOutAndWipe({ onComplete, ...deps })

    expect(clearAuthToken).toHaveBeenCalledTimes(1)
    expect(clearDeviceId).toHaveBeenCalledTimes(1)
  })

  it('passes the captured serverId to the credential clearers (registry already cleared)', async () => {
    // Regression: clearLocalData clears `activeTrustDomain` from the registry
    // before broadcasting db-closing (#932 r3369942991). The deferred
    // credential clear would no-op if it read serverId from the registry at
    // that point — the per-server localStorage keys would survive sign-out
    // and the next ModePicker → activateServer → boot path would auto-sign-in
    // off the stale token.
    const onComplete = mock(() => {})

    await signOutAndWipe({ onComplete, ...deps })

    expect(clearAuthToken).toHaveBeenCalledWith(serverId)
    expect(clearDeviceId).toHaveBeenCalledWith(serverId)
  })
})
