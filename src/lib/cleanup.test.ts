/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  beginDebugTranscriptTurn,
  clearDebugTranscriptRecorder,
  getDebugTranscriptNotes,
  setDebugTranscriptCaptureEnabled,
} from '@/debug-transcript/recorder'
import { clearIdentityScopedMemory } from './identity-memory'

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
