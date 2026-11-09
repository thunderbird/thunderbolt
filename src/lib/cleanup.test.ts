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
import { clearLocalData } from './cleanup'
import * as authToken from './auth-token'
import * as fileBlobStorage from './file-blob-storage'
import * as fs from './fs'
import { clearIdentityScopedMemory } from './identity-memory'
import { getIdentitySignal } from './identity-lifetime'
import {
  captureOtariBrowserReturn,
  clearOtariBrowserReturn,
  getOtariBrowserReturn,
  startOtariBrowserConnection,
} from './otari-browser-auth'
import { getOAuthState, setOAuthState } from './oauth-state'
import { getMcpOAuthState, isMcpOAuthCallback, setMcpOAuthState } from './mcp-auth/mcp-oauth-state'
import { providerAuthorizationDraftKey, providerAuthorizationDraftStorage } from '@/providers/authorization-draft'

const authorizationState = 'n'.repeat(43)
/** Start an actual tab handoff while replacing only browser navigation and provider transport. */
const startOtari = async (exchange = async (_origin: string, _grant: unknown, _signal: AbortSignal) => 'token') => {
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

describe('clearLocalData', () => {
  const llava = { provider: 'custom', model: 'llava', url: 'http://localhost:11434/v1', vendor: null } as const
  // Only the image-support side effects are under test, so skip the steps that
  // need a real database, adapters, sync, encryption keys, or auth state.
  const onlyLocalSteps = { disableSync: false, clearEncryptionKeys: false, clearAuth: false }

  beforeEach(() => {
    spyOn(fs, 'resetAppDir').mockResolvedValue()
    spyOn(fileBlobStorage, 'clearAllAttachments').mockResolvedValue()
    spyOn(adapterCache, 'disposeAllAdapters').mockResolvedValue()
    setCachedImageSupport(llava, 'supported')
  })
  afterEach(() => {
    clearImageSupportCache()
    // Bun shares one process across test files; don't leak these spies.
    mock.restore()
  })

  it('forgets image-support results and web storage along with the local database', async () => {
    localStorage.setItem('oauth_flow_state', 'x')
    sessionStorage.setItem('oauth_connecting', 'x')
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: true })
    expect(getCachedImageSupport(llava)).toBeUndefined()
    expect(fileBlobStorage.clearAllAttachments).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps them when the database stays ("Leave data on device")', async () => {
    localStorage.setItem('retained-local-preference', 'x')
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })
    expect(getCachedImageSupport(llava)).toBe('supported')
    expect(fileBlobStorage.clearAllAttachments).not.toHaveBeenCalled()
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

  it('aborts a claimed provider exchange before asynchronous teardown and permits new identity work', async () => {
    const pending = Promise.withResolvers<string>()
    const exchange = mock(async (_origin: string, _grant: unknown, signal: AbortSignal) => {
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
})
