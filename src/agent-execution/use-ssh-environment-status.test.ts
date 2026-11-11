/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import * as platform from '@/lib/platform'
import * as tauri from '@tauri-apps/api/core'
import { useSshEnvironmentsStore } from './ssh-environments'
import { useSshEnvironmentStatus } from './use-ssh-environment-status'

const environment = {
  id: crypto.randomUUID(),
  name: 'SSH',
  host: 'orb',
  cwd: '~',
  authentication: 'agent' as const,
  deletedAt: null,
}

beforeEach(() => {
  spyOn(tauri, 'invoke').mockClear()
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
})
afterEach(() => {
  cleanup()
  mock.restore()
  useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
})

it('automatically shares authenticated probes and turns red on a failed refresh', async () => {
  const pending = Promise.withResolvers<unknown>()
  const invoke = spyOn(tauri, 'invoke').mockImplementation(
    async <T>(command: string): Promise<T> =>
      (command === 'agent_ssh_request' ? await pending.promise : undefined) as T,
  )
  const wrapper = createQueryTestWrapper()
  const view = renderHook(() => [useSshEnvironmentStatus(environment.id), useSshEnvironmentStatus(environment.id)], {
    wrapper,
  })
  expect(view.result.current[0].status).toBe('checking')
  await act(async () => {
    view.result.current[0].refresh()
    view.result.current[1].refresh()
    await getClock().tickAsync(5)
  })
  expect(view.result.current[0].status).toBe('checking')
  await act(async () => {
    pending.resolve({ cwd: '/home/test', platform: 'linux' })
    await getClock().tickAsync(5)
  })
  expect(view.result.current[0].status).toBe('connected')
  expect(view.result.current[1].status).toBe('connected')
  expect(invoke.mock.calls.filter(([command]) => command === 'agent_ssh_request')).toHaveLength(1)
  invoke.mockImplementation(async <T>(command: string): Promise<T> => {
    if (command === 'agent_ssh_request') {
      throw new Error('Host key verification failed')
    }
    return undefined as T
  })
  await act(async () => {
    view.result.current[0].refresh()
    await getClock().tickAsync(5)
  })
  expect(view.result.current[0].status).toBe('disconnected')
  expect(view.result.current[0].error).toContain('Host key verification failed')
})

it('ignores a successful probe for an old destination after the profile changes', async () => {
  const oldProbe = Promise.withResolvers<unknown>()
  spyOn(tauri, 'invoke').mockImplementation(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command !== 'agent_ssh_request') {
      return undefined as T
    }
    const connection = (args as { connection: { host: string } }).connection
    if (connection.host === 'orb') {
      return (await oldProbe.promise) as T
    }
    throw new Error('New destination offline')
  })
  const view = renderHook(() => useSshEnvironmentStatus(environment.id), { wrapper: createQueryTestWrapper() })
  await act(async () => {
    view.result.current.refresh()
    await getClock().tickAsync(5)
  })
  await act(async () => {
    useSshEnvironmentsStore.getState().saveEnvironment({ ...environment, host: 'other' })
  })
  expect(view.result.current.status).toBe('checking')
  await act(async () => {
    view.result.current.refresh()
    await getClock().tickAsync(5)
  })
  expect(view.result.current.status).toBe('disconnected')
  await act(async () => {
    oldProbe.resolve({ cwd: '/old', platform: 'linux' })
  })
  expect(view.result.current.status).toBe('disconnected')
  expect(view.result.current.error).toContain('New destination offline')
})

it('retains a successful check across remounts without repeated background authentication', async () => {
  const invoke = spyOn(tauri, 'invoke').mockImplementation(
    async <T>(command: string): Promise<T> =>
      (command === 'agent_ssh_request' ? { cwd: '/remote', platform: 'linux' } : undefined) as T,
  )
  const view = renderHook(() => useSshEnvironmentStatus(environment.id), { wrapper: createQueryTestWrapper() })
  await act(async () => {
    view.result.current.refresh()
    await getClock().tickAsync(5)
  })
  expect(view.result.current.status).toBe('connected')
  await act(async () => {
    await getClock().tickAsync(30_001)
  })
  expect(view.result.current.status).toBe('connected')
  view.unmount()
  const restored = renderHook(() => useSshEnvironmentStatus(environment.id), { wrapper: createQueryTestWrapper() })
  expect(restored.result.current.status).toBe('connected')
  await act(async () => {
    await getClock().tickAsync(5)
  })
  expect(invoke.mock.calls.filter(([command]) => command === 'agent_ssh_request')).toHaveLength(1)
})

it.each(['web', 'missing', 'deleted'] as const)(
  'does not cross IPC for an unavailable %s environment',
  async (reason) => {
    if (reason === 'web') {
      spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
    }
    if (reason === 'missing') {
      useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
    }
    if (reason === 'deleted') {
      useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
    }
    const invoke = spyOn(tauri, 'invoke')
    const view = renderHook(() => useSshEnvironmentStatus(environment.id), { wrapper: createQueryTestWrapper() })
    expect(view.result.current.status).toBe('disconnected')
    act(() => view.result.current.refresh())
    expect(invoke).not.toHaveBeenCalled()
  },
)
