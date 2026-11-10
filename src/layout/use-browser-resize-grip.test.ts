/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as platform from '@/lib/platform'
import { getClock } from '@/testing-library'
import * as tauriCore from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useBrowserResizeGrip } from './use-browser-resize-grip'

const calls: { command: string; args: Record<string, unknown> }[] = []
let platformSpy: ReturnType<typeof spyOn<typeof platform, 'isTauriDesktop'>>
let invokeSpy: ReturnType<typeof spyOn<typeof tauriCore, 'invoke'>>

beforeEach(() => {
  calls.length = 0
  platformSpy = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  mockWindows('main')
  mockIPC(
    (command, payload) => {
      calls.push({ command, args: (payload ?? {}) as Record<string, unknown> })
      if (command === 'plugin:webview|webview_position') {
        return { x: 20, y: 60 }
      }
      if (command === 'plugin:window|scale_factor') {
        return 2
      }
    },
    { shouldMockEvents: true },
  )
  const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: typeof tauriCore.invoke }
  invokeSpy = spyOn(tauriCore, 'invoke').mockImplementation(internals.invoke)
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  invokeSpy.mockRestore()
  platformSpy.mockRestore()
  clearMocks()
})

/** Mount a measured separator before its native synchronization effect runs. */
const setup = async () => {
  const separator = document.createElement('div')
  const grip = document.createElement('div')
  grip.dataset.slot = 'resizable-handle-grip'
  separator.append(grip)
  separator.getBoundingClientRect = () => new DOMRect(576, 0, 24, 768)
  const resize = mock((_size: number | string) => {})
  const panelRef = {
    current: {
      getSize: () => ({ inPixels: 400, asPercentage: 50 }),
      resize,
      collapse: () => {},
      expand: () => {},
      isCollapsed: () => false,
    },
  }
  const beginResize = mock(() => {})
  const endResize = mock(async () => {})
  const hook = renderHook(
    ({ enabled }) => {
      const value = useBrowserResizeGrip({ enabled, panelRef, beginResize, endResize })
      value.separatorRef.current = separator
      return value
    },
    { initialProps: { enabled: true } },
  )
  await act(async () => {
    await getClock().tickAsync(20)
  })
  const owner = calls.find(({ command }) => command === 'browser_resize_update')?.args.owner as string
  const send = async (phase: 'start' | 'move' | 'end', screenX: number, eventOwner = owner, gesture = 1) => {
    await act(async () => {
      await emit('browser-resize-drag', { owner: eventOwner, gesture, phase, screenX })
    })
  }
  return { ...hook, owner, send, resize, beginResize, endResize }
}

describe('useBrowserResizeGrip', () => {
  it('centers the native surface on the divider and window with logical coordinates', async () => {
    const hook = await setup()
    const update = calls.find(({ command }) => command === 'browser_resize_update')!
    expect(update.args.presentation).toMatchObject({ x: 598, y: Math.round(window.innerHeight / 2 + 10) })
    expect(hook.result.current.nativeReady).toBe(true)
    hook.rerender({ enabled: false })
    await act(async () => {})
    expect(calls.filter(({ command }) => command === 'browser_resize_update').at(-1)?.args).toEqual({
      owner: hook.owner,
      presentation: null,
    })
  })

  it('resizes only matching gestures and ends persistence once on release', async () => {
    const hook = await setup()
    await hook.send('start', 100, 'stale')
    await hook.send('move', 140)
    expect(hook.resize).not.toHaveBeenCalled()
    await hook.send('start', 100)
    await hook.send('move', 120, hook.owner, 2)
    expect(hook.resize).not.toHaveBeenCalled()
    await hook.send('move', 140)
    expect(hook.resize).toHaveBeenLastCalledWith('360px')
    expect(document.documentElement.dataset.browserResizing).toBe('true')
    expect(hook.endResize).not.toHaveBeenCalled()
    await hook.send('end', 160)
    expect(hook.resize).toHaveBeenLastCalledWith('340px')
    expect(hook.beginResize).toHaveBeenCalledTimes(1)
    expect(hook.endResize).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset.browserResizing).toBeUndefined()
  })

  it('keeps the HTML grip when native surfaces are unavailable', async () => {
    platformSpy.mockReturnValue(false)
    const hook = await setup()
    expect(hook.result.current.nativeReady).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
