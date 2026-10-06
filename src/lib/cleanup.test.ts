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
import * as fs from './fs'
import { clearIdentityScopedMemory } from './identity-memory'

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

  it('forgets image-support results along with the local database', async () => {
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: true })
    expect(getCachedImageSupport(llava)).toBeUndefined()
  })

  it('keeps them when the database stays ("Leave data on device")', async () => {
    await clearLocalData({ ...onlyLocalSteps, clearDatabase: false })
    expect(getCachedImageSupport(llava)).toBe('supported')
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
})
