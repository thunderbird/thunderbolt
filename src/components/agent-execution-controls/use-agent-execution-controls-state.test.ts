/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import * as tauriCore from '@tauri-apps/api/core'
import { getAgentExecution, useAgentExecutionStore } from '@/agent-execution/store'
import { useAgentExecutionControlsState } from './use-agent-execution-controls-state'

afterEach(() => {
  cleanup()
  mock.restore()
  useAgentExecutionStore.setState({ byThread: {} })
})

describe('native workspace selection', () => {
  it('uses the selected folder and preserves the chat access policy', async () => {
    useAgentExecutionStore.getState().setExecution('picker', { location: 'sandbox', access: 'full' })
    const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue('/Users/test/project')
    const { result } = renderHook(() => useAgentExecutionControlsState('picker'))

    await act(async () => result.current.openFolder())

    expect(invoke).toHaveBeenCalledWith('agent_pick_workspace', { path: null, title: 'Work on this computer' })
    expect(getAgentExecution('picker')).toEqual({ location: 'computer', access: 'full', cwd: '/Users/test/project' })
  })

  it('starts in the previous folder and leaves it unchanged when cancelled', async () => {
    const execution = { location: 'computer', access: 'ask', cwd: '/Users/test/project' } as const
    useAgentExecutionStore.getState().setExecution('picker', execution)
    const invoke = spyOn(tauriCore, 'invoke').mockResolvedValue(null)
    const { result } = renderHook(() => useAgentExecutionControlsState('picker'))

    await act(async () => result.current.openFolder())

    expect(invoke).toHaveBeenCalledWith('agent_pick_workspace', {
      path: execution.cwd,
      title: 'Work on this computer',
    })
    expect(getAgentExecution('picker')).toEqual(execution)
    expect(result.current.error).toBeNull()
  })

  it('keeps sandbox selected if the native picker fails', async () => {
    spyOn(tauriCore, 'invoke').mockRejectedValue(new Error('Dialog unavailable'))
    const { result } = renderHook(() => useAgentExecutionControlsState('picker'))

    await act(async () => result.current.openFolder())

    expect(getAgentExecution('picker').location).toBe('sandbox')
    expect(result.current.error).toBe('Could not select a working folder. Please try again.')
  })
})
