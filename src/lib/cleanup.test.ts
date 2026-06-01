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

const clearAuthToken = mock(() => {
  calls.push('clearAuthToken')
})

const clearDeviceId = mock(() => {
  calls.push('clearDeviceId')
})

const handleFullWipe = mock(async () => {
  calls.push('handleFullWipe')
})

// Include the full surface so this test's mock.module call doesn't shadow the real
// exports for other test files (see docs/development/testing.md §65).
mock.module('@/db/db-lifecycle-broadcast', () => ({
  broadcastDbLifecycle,
  setupDbLifecycleReloadOnRemoteClose: () => {},
}))

mock.module('@/db/database', () => ({
  resetDatabase,
}))

mock.module('@/db/powersync', () => ({
  setSyncEnabled,
}))

mock.module('@/lib/fs', () => ({
  deleteDbFile,
}))

mock.module('@/lib/auth-token', () => ({
  clearAuthToken,
  clearDeviceId,
}))

mock.module('@/services/encryption', () => ({
  handleFullWipe,
}))

// Import after module mocks so the SUT picks them up.
const { clearLocalData, signOutAndWipe } = await import('./cleanup')

const serverId = '00000000-0000-0000-0000-0000000000aa'

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
    await clearLocalData()

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

    await clearLocalData()

    const state = useLocalSettingsStore.getState()
    expect(state.theme).toBe(initialLocalSettings.theme)
    expect(state.debugPosthog).toBe(initialLocalSettings.debugPosthog)
    expect(state.hapticsEnabled).toBe(initialLocalSettings.hapticsEnabled)
  })

  it('skips encryption-key wipe in standalone mode', async () => {
    useTrustDomainRegistry.setState({ activeTrustDomain: { kind: 'standalone' } })

    await clearLocalData()

    expect(calls).toContain('deleteDbFile:standalone.db')
    expect(calls).not.toContain('handleFullWipe')
  })

  it('continues through the sequence when a step throws', async () => {
    setSyncEnabled.mockRejectedValueOnce(new Error('powersync hiccup'))
    resetDatabase.mockRejectedValueOnce(new Error('close failed'))
    handleFullWipe.mockRejectedValueOnce(new Error('IDB gone'))

    await clearLocalData()

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

    await clearLocalData()

    expect(broadcastDbLifecycle).not.toHaveBeenCalled()
    expect(deleteDbFile).not.toHaveBeenCalled()
    expect(calls).toContain('clearAuthToken')
    expect(calls).toContain('clearDeviceId')
  })
})

describe('signOutAndWipe', () => {
  const mockReplace = mock()

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
      value: { replace: mockReplace },
      writable: true,
    })
  })

  it('calls signOut → clearLocalData → onComplete in that order', async () => {
    const signOut = mock(async () => {
      calls.push('signOut')
    })
    const onComplete = mock(() => {
      calls.push('onComplete')
    })

    await signOutAndWipe({ signOut, onComplete })

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('signOut')
    expect(calls).toContain(`deleteDbFile:server-${serverId}.db`)
    expect(calls[calls.length - 1]).toBe('onComplete')
  })

  it('skips signOut when not provided (revoked-device path)', async () => {
    const onComplete = mock(() => {})

    await signOutAndWipe({ onComplete })

    expect(calls[0]).toBe('setSyncEnabled:false')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('still fires onComplete if signOut throws', async () => {
    const signOut = mock(async () => {
      throw new Error('network down')
    })
    const onComplete = mock(() => {})

    await signOutAndWipe({ signOut, onComplete })

    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('still fires onComplete if clearLocalData throws (resetDatabase rejects)', async () => {
    resetDatabase.mockRejectedValueOnce(new Error('close failed'))
    const onComplete = mock(() => {})

    await signOutAndWipe({ onComplete })

    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
