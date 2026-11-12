/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as adapterCache from '@/acp/adapter-cache'
import { clearImageSupportCache, getCachedImageSupport, setCachedImageSupport } from '@/ai/image-support'
import {
  beginDebugTranscriptTurn,
  clearDebugTranscriptRecorder,
  getDebugTranscriptNotes,
  setDebugTranscriptCaptureEnabled,
} from '@/debug-transcript/recorder'
import { clearLocalData, clearLocalDataOrThrow } from './cleanup'
import { withKeyStoreLock } from '@/crypto/key-store-lock'
import { getCachedSession, setCachedSession } from './session-cache'
import { captureKeyStorageLifetime } from '@/crypto/key-storage-lifetime'
import * as encryption from '@/services/encryption'
import * as authToken from './auth-token'
import * as fs from './fs'
import { clearIdentityScopedMemory } from './identity-memory'
import { getIdentitySignal } from './identity-lifetime'
import { queryClient } from './query-client'
import {
  captureOtariBrowserReturn,
  clearOtariBrowserReturn,
  getOtariBrowserReturn,
  startOtariBrowserConnection,
} from './otari-browser-auth'
import { getOAuthState, setOAuthState } from './oauth-state'
import { getMcpOAuthState, isMcpOAuthCallback, setMcpOAuthState } from './mcp-auth/mcp-oauth-state'
import { providerAuthorizationDraftKey, providerAuthorizationDraftStorage } from '@/providers/authorization-draft'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import type { exchangeOtariCode } from './otari-auth'

const authorizationState = 'n'.repeat(43)
/** Start an actual tab handoff while replacing only browser navigation and provider transport. */
const startOtari = async (exchange: typeof exchangeOtariCode = async () => 'token') => {
  const dependencies = {
    mobile: () => false,
    storage: () => sessionStorage,
    currentUrl: () => new URL('https://app.test/settings/connections'),
    navigate: () => {},
    verifier: () => authorizationState,
    challenge: async () => 'challenge',
    exchange,
  }
  await startOtariBrowserConnection(
    'https://otari.ai',
    'connections',
    new AbortController().signal,
    {
      provider: 'otari',
      revision: 'original',
    },
    dependencies,
  )
  return dependencies
}
import { attestationStore } from '@/attestation/store'

describe('clearLocalData', () => {
  const llava = { provider: 'custom', model: 'llava', url: 'http://localhost:11434/v1', vendor: null } as const
  // Only the image-support side effects are under test, so skip the steps that
  // need a real database, adapters, sync, encryption keys, or auth state.
  const onlyLocalSteps = { disableSync: false, clearEncryptionKeys: false, clearAuth: false }

  beforeEach(() => {
    spyOn(fs, 'resetAppDir').mockResolvedValue()
    spyOn(adapterCache, 'disposeAllAdapters').mockResolvedValue()
    setCachedImageSupport(llava, 'supported')
  })
  afterEach(() => {
    clearImageSupportCache()
    // Bun shares one process across test files; don't leak these spies.
    mock.restore()
  })

  it('invalidates key operations before waiting for adapter disposal', async () => {
    const pending = Promise.withResolvers<void>()
    spyOn(adapterCache, 'disposeAllAdapters').mockReturnValue(pending.promise)
    spyOn(encryption, 'handleFullWipe').mockResolvedValue()
    const assertCurrent = captureKeyStorageLifetime()
    const clearing = clearLocalData({ ...onlyLocalSteps, clearEncryptionKeys: true, clearDatabase: false })
    expect(assertCurrent).toThrow('Encryption operation cancelled')
    expect(encryption.handleFullWipe).not.toHaveBeenCalled()
    pending.resolve()
    await clearing
    expect(encryption.handleFullWipe).toHaveBeenCalledTimes(1)
  })

  it('holds the browser writer lock until both old keys and the cached account are removed', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    spyOn(adapterCache, 'disposeAllAdapters').mockImplementation(async () => {
      entered.resolve()
      await release.promise
    })
    spyOn(encryption, 'handleFullWipe').mockResolvedValue()
    setCachedSession({ user: { id: 'old-account' } })
    const clearing = clearLocalData({ disableSync: false, clearEncryptionKeys: true, clearDatabase: false })
    await entered.promise
    const writer = mock(async () => getCachedSession())
    const nextWriter = withKeyStoreLock(writer)
    await Promise.resolve()
    expect(writer).not.toHaveBeenCalled()
    release.resolve()
    await clearing
    expect(await nextWriter).toBeNull()
  })

  it('keeps pending key operations valid when sign-out retains encryption keys', async () => {
    const assertCurrent = captureKeyStorageLifetime()
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })
    expect(assertCurrent).not.toThrow()
  })

  it('forgets image-support results and web storage along with the local database', async () => {
    localStorage.setItem('oauth_flow_state', 'x')
    sessionStorage.setItem('oauth_connecting', 'x')
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: true })
    expect(getCachedImageSupport(llava)).toBeUndefined()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps them when the database stays ("Leave data on device")', async () => {
    localStorage.setItem('retained-local-preference', 'x')
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })
    expect(getCachedImageSupport(llava)).toBe('supported')
    expect(fs.resetAppDir).not.toHaveBeenCalled()
    expect(localStorage.getItem('retained-local-preference')).toBe('x')
    localStorage.removeItem('retained-local-preference')
  })

  it('rejects late integration and MCP callbacks after retained-data identity teardown', async () => {
    setOAuthState({ state: 'google-nonce', provider: 'google', verifier: 'google-verifier' })
    setMcpOAuthState({ serverId: 'oauth:exa', stateNonce: 'mcp-nonce', codeVerifier: 'mcp-verifier' })
    providerAuthorizationDraftStorage().setItem(providerAuthorizationDraftKey, '{"provider":"exa"}')

    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })

    expect(getOAuthState().state).toBeNull()
    expect(getMcpOAuthState().stateNonce).toBeNull()
    expect(isMcpOAuthCallback({ code: 'late-code', state: 'mcp-nonce', error: null })).toBe(false)
    expect(providerAuthorizationDraftStorage().getItem(providerAuthorizationDraftKey)).toBeNull()
  })

  it('retires a real pending provider authorization even when local data is retained', async () => {
    const dependencies = await startOtari()
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })
    expect(
      captureOtariBrowserReturn(
        new URL(`https://app.test/oauth/otari?code=late&state=${authorizationState}`),
        dependencies,
      ),
    ).toBeNull()
  })

  it('forgets them when another account signs in, whose database is not this one', async () => {
    localStorage.setItem('oauth_flow_state', 'x')
    localStorage.setItem('mcp_oauth_flow_state', 'x')
    localStorage.setItem('thunderbolt_locale', 'de')
    useSearchProviderStore.getState().selectSearchConnection('connection-of-a')
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false, keepSession: true })
    expect(getCachedImageSupport(llava)).toBeUndefined()
    expect(localStorage.getItem('oauth_flow_state')).toBeNull()
    expect(localStorage.getItem('mcp_oauth_flow_state')).toBeNull()
    expect(localStorage.getItem('thunderbolt_locale')).toBeNull()
    expect(useSearchProviderStore.getState().selection).toBe('auto')
    expect(useSearchProviderStore.getState().connectionId).toBeNull()
  })

  it('clears web storage only after removing the token, so other tabs hear about the sign-out', async () => {
    // Other tabs react to the keyed `storage` event of the token removal; clear() sends
    // only an unkeyed one, so the token must still be there to remove when it runs.
    localStorage.setItem('retained-local-preference', 'x')
    let storageIntactAtTokenRemoval = false
    spyOn(authToken, 'clearAuthToken').mockImplementation(() => {
      storageIntactAtTokenRemoval = localStorage.getItem('retained-local-preference') !== null
    })

    await clearLocalData({ disableSync: false, clearEncryptionKeys: false, clearDatabase: true, clearAuth: true })

    expect(storageIntactAtTokenRemoval).toBe(true)
    expect(localStorage.length).toBe(0)
  })

  it('keeps the new account’s session but drops the old account’s device credentials', async () => {
    authToken.setAuthToken('token-of-b')
    setCachedSession({ user: { id: 'user-b' } })
    const deviceId = authToken.getDeviceId()
    await clearLocalData({ ...onlyLocalSteps, clearAuth: true, keepSession: true, clearDatabase: false })
    expect(authToken.getAuthToken()).toBe('token-of-b')
    expect(getCachedSession()?.user?.id).toBe('user-b')
    expect(authToken.getDeviceId()).not.toBe(deviceId)
    authToken.clearAuthToken()
  })

  it('clearLocalDataOrThrow runs every step, then rejects when one failed', async () => {
    spyOn(encryption, 'handleFullWipe').mockRejectedValue(new Error('key store locked'))
    spyOn(console, 'error').mockImplementation(() => {})
    authToken.setAuthToken('token')
    await expect(
      clearLocalDataOrThrow({ ...onlyLocalSteps, clearEncryptionKeys: true, clearAuth: true, clearDatabase: false }),
    ).rejects.toThrow('Failed to clear local data')
    expect(authToken.getAuthToken()).toBeNull()
  })
})

describe('clearIdentityScopedMemory', () => {
  beforeEach(() => {
    setDebugTranscriptCaptureEnabled(true)
    clearDebugTranscriptRecorder()
  })
  afterEach(() => {
    clearIdentityScopedMemory()
    sessionStorage.removeItem('thunderbolt.otari.authorization')
  })

  it('removes capability discovery results before the next identity can reuse a stable OAuth id', () => {
    const key = ['otari-web-capabilities', 'oauth:otari', 'https://otari.example/api/v1', 'session']
    queryClient.setQueryData(key, { search: 'available', fetch: 'available' })
    clearIdentityScopedMemory()
    expect(queryClient.getQueryData(key)).toBeUndefined()
  })

  it('aborts a claimed provider exchange before asynchronous teardown and permits new identity work', async () => {
    const pending = Promise.withResolvers<string>()
    const exchange = mock<typeof exchangeOtariCode>(async (_origin, _grant, signal) => {
      const token = await pending.promise
      signal.throwIfAborted()
      return token
    })
    const dependencies = await startOtari(exchange)
    const returned = captureOtariBrowserReturn(
      new URL(`https://app.test/oauth/otari?code=one-use&state=${authorizationState}`),
      dependencies,
    )!
    clearOtariBrowserReturn(returned.id)
    expect(getOtariBrowserReturn()).toBeNull()
    const result = returned.complete()
    const previousIdentity = getIdentitySignal()

    clearIdentityScopedMemory()

    expect(previousIdentity.aborted).toBe(true)
    expect(getIdentitySignal().aborted).toBe(false)
    expect(exchange.mock.calls[0][2].aborted).toBe(true)
    pending.resolve('late-token')
    await expect(result).rejects.toHaveProperty('name', 'AbortError')
  })

  it('always clears session-scoped debug transcripts', async () => {
    beginDebugTranscriptTurn({
      threadId: 'thread-1',
      traceId: 'trace-1',
      engine: 'pi',
      model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
      agentId: 'built-in',
    })

    clearIdentityScopedMemory()

    expect(getDebugTranscriptNotes('thread-1')).toEqual([])
  })

  it('revokes inference evidence and pending reporters when the identity changes', () => {
    const key = 'tinfoil:user'
    const reporter = attestationStore.open(key)
    const evidence = {
      provider: 'Tinfoil',
      endpoint: 'inference.tinfoil.sh',
      verifiedAt: 0,
      checks: [] as const,
      details: [],
    }
    reporter.publish({ status: 'verified', evidence })

    clearIdentityScopedMemory()
    expect(attestationStore.getSnapshot(key)).toEqual({ status: 'idle' })
    reporter.publish({ status: 'verified', evidence })
    expect(attestationStore.getSnapshot(key)).toEqual({ status: 'idle' })
  })
})
