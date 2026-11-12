/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import type { LocalAppStatus } from '@shared/local-app-protocol'
import { createLocalAppController } from './local-app-controller'
import { useLocalAppStore } from './local-app-store'
import { useLocalAppUrl } from './use-local-app-url'

afterEach(() => useLocalAppStore.setState({ apps: {} }))

it.each([false, true])(
  'updates the mounted page after restart (fixed port: %s) without duplicate StrictMode launches',
  async (fixedPort) => {
    useLocalAppStore.setState({ apps: {} })
    let starts = 0
    let state: LocalAppStatus | null = null
    const native = async <T,>(command: string, args: Record<string, unknown>): Promise<T> => {
      const id = String(args.id ?? (args.request as { id: string })?.id)
      if (command === 'agent_preview_start') {
        state = {
          id,
          status: 'ready',
          url: `http://127.0.0.1:${4000 + (fixedPort ? ++starts && 1 : ++starts)}/`,
          error: null,
          logs: '',
        }
      }
      if (command === 'agent_preview_stop') {
        state = { id, status: 'stopped', url: null, error: null, logs: '' }
      }
      return state as T
    }
    const controller = createLocalAppController(native, () => true)
    const app = controller.create({
      owner: { kind: 'project', id: 'one' },
      cwd: '/tmp/one',
      title: 'Local',
      launch: { executable: 'bun', args: [] },
    })
    const onError = mock(() => {})
    const { result } = renderHook(() => useLocalAppUrl(app.id, onError, controller), { wrapper: StrictMode })
    await act(async () => {
      await controller.start(app.id)
    })
    expect(result.current).toEqual({ url: 'http://127.0.0.1:4001/', generation: 1 })
    expect(starts).toBe(1)
    await act(async () => {
      await controller.restart(app.id)
    })
    expect(result.current).toEqual({ url: `http://127.0.0.1:${fixedPort ? 4001 : 4002}/`, generation: 2 })
    await act(async () => {
      await controller.status(app.id)
      await controller.start(app.id)
    })
    expect(result.current.generation).toBe(2)
    expect(starts).toBe(2)
    expect(onError).toHaveBeenLastCalledWith(null)
  },
)

it('clears the visible forwarded URL when its managed preview becomes unavailable', async () => {
  const listeners = new Set<(status: LocalAppStatus) => void>()
  const ready: LocalAppStatus = {
    id: 'remote-app',
    status: 'ready',
    url: 'http://127.0.0.1:41234/',
    error: null,
    logs: '',
  }
  const controller = {
    start: async () => ready,
    subscribe: (listener: (status: LocalAppStatus) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const onError = mock(() => {})
  const { result } = renderHook(() => useLocalAppUrl(ready.id, onError, controller))
  await act(async () => {})
  expect(result.current.url).toBe(ready.url)
  act(() => {
    for (const listener of listeners) {
      listener({ ...ready, status: 'failed', url: null, error: 'SSH environment was removed' })
    }
  })
  expect(result.current.url).toBeNull()
  expect(onError).toHaveBeenLastCalledWith('SSH environment was removed')
})
