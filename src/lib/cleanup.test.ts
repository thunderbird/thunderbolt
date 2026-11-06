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
import { withKeyStoreLock } from '@/crypto/key-store-lock'
import { getCachedSession, setCachedSession } from './session-cache'
import { captureKeyStorageLifetime } from '@/crypto/key-storage-lifetime'
import * as encryption from '@/services/encryption'
import * as authToken from './auth-token'
import * as fileBlobStorage from './file-blob-storage'
import * as fs from './fs'
import { clearIdentityScopedMemory } from './identity-memory'
import { attestationStore } from '@/attestation/store'

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
    expect(fileBlobStorage.clearAllAttachments).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps them when the database stays ("Leave data on device")', async () => {
    localStorage.setItem('oauth_flow_state', 'x')
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })
    expect(getCachedImageSupport(llava)).toBe('supported')
    expect(fileBlobStorage.clearAllAttachments).not.toHaveBeenCalled()
    expect(localStorage.getItem('oauth_flow_state')).toBe('x')
    localStorage.removeItem('oauth_flow_state')
  })

  it('clears web storage only after removing the token, so other tabs hear about the sign-out', async () => {
    // Other tabs react to the keyed `storage` event of the token removal; clear() sends
    // only an unkeyed one, so the token must still be there to remove when it runs.
    localStorage.setItem('oauth_flow_state', 'x')
    let storageIntactAtTokenRemoval = false
    spyOn(authToken, 'clearAuthToken').mockImplementation(() => {
      storageIntactAtTokenRemoval = localStorage.getItem('oauth_flow_state') !== null
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
  afterEach(clearDebugTranscriptRecorder)

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
