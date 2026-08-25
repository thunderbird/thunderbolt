/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { registerDebugTranscriptCapture } from './config-capture'
import {
  beginDebugTranscriptTurn,
  clearDebugTranscriptRecorder,
  getDebugTranscriptNotes,
  setDebugTranscriptCaptureEnabled,
} from './recorder'

const recordTurn = (traceId: string) => {
  beginDebugTranscriptTurn({
    threadId: 'thread-1',
    traceId,
    engine: 'pi',
    model: { id: 'model-1', name: 'Claude', provider: 'anthropic' },
    agentId: 'built-in',
  })
}

const resetCapture = () => {
  useConfigStore.setState({ config: {} })
  clearDebugTranscriptRecorder()
}

describe('debug transcript config capture', () => {
  beforeEach(resetCapture)
  afterEach(resetCapture)

  it('forces standalone capture off during immediate registration', () => {
    setDebugTranscriptCaptureEnabled(true)
    const setCaptureEnabled = mock((enabled: boolean) => setDebugTranscriptCaptureEnabled(enabled))
    const unsubscribe = registerDebugTranscriptCapture(setCaptureEnabled)
    recordTurn('trace-standalone')

    expect(setCaptureEnabled).toHaveBeenLastCalledWith(false)
    expect(getDebugTranscriptNotes('thread-1')).toEqual([])
    unsubscribe()
  })

  it('seeds persisted disabled config off', () => {
    useConfigStore.setState({ config: { debugTranscriptsEnabled: false } })
    setDebugTranscriptCaptureEnabled(true)
    const setCaptureEnabled = mock((enabled: boolean) => setDebugTranscriptCaptureEnabled(enabled))
    const unsubscribe = registerDebugTranscriptCapture(setCaptureEnabled)
    recordTurn('trace-persisted-disabled')

    expect(setCaptureEnabled).toHaveBeenLastCalledWith(false)
    expect(getDebugTranscriptNotes('thread-1')).toEqual([])
    unsubscribe()
  })

  it('seeds persisted enabled config on', () => {
    useConfigStore.setState({ config: { debugTranscriptsEnabled: true } })
    setDebugTranscriptCaptureEnabled(false)
    const setCaptureEnabled = mock((enabled: boolean) => setDebugTranscriptCaptureEnabled(enabled))
    const unsubscribe = registerDebugTranscriptCapture(setCaptureEnabled)
    recordTurn('trace-persisted-enabled')

    expect(setCaptureEnabled).toHaveBeenLastCalledWith(true)
    expect(getDebugTranscriptNotes('thread-1')).toHaveLength(1)
    unsubscribe()
  })

  it('enables on config update, then clears and latches off', () => {
    useConfigStore.getState().updateConfig({ debugTranscriptsEnabled: true })
    recordTurn('trace-enabled')
    expect(getDebugTranscriptNotes('thread-1')).toHaveLength(1)

    useConfigStore.getState().updateConfig({})
    recordTurn('trace-disabled')

    expect(getDebugTranscriptNotes('thread-1')).toEqual([])
  })
})
