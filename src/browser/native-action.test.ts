/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import type { invoke } from '@tauri-apps/api/core'
import { invokeBrowserAction } from './native-action'

const action = { type: 'key', key: 'Enter' } as const
const setup = (override: (command: string) => Promise<unknown> = async () => undefined) => {
  const native = mock(
    async <T>(command: string, _args?: Parameters<typeof invoke>[1]): Promise<T> =>
      (command === 'browser_begin_agent_action' ? 7 : await override(command)) as T,
  )
  return native
}

it('acquires an exact native ticket and releases it after success', async () => {
  const native = setup()
  await invokeBrowserAction('tab', action, undefined, native as typeof invoke)
  expect(native.mock.calls).toEqual([
    ['browser_begin_agent_action', { label: 'tab' }],
    ['browser_agent_action', { label: 'tab', operationId: 7, action }],
    ['browser_cancel_agent_action', { label: 'tab', operationId: 7 }],
  ])
})

it('does not begin input for an already aborted request', async () => {
  const native = setup()
  await expect(invokeBrowserAction('tab', action, AbortSignal.abort(), native as typeof invoke)).rejects.toThrow()
  expect(native).not.toHaveBeenCalled()
})

it('revokes a ticket acquired after Stop without dispatching input', async () => {
  const begin = Promise.withResolvers<number>()
  const native = mock(
    async <T>(command: string): Promise<T> =>
      (command === 'browser_begin_agent_action' ? await begin.promise : undefined) as T,
  )
  const abort = new AbortController()
  const pending = invokeBrowserAction('tab', action, abort.signal, native as typeof invoke)
  abort.abort(new Error('Stopped'))
  begin.resolve(42)
  await expect(pending).rejects.toThrow('Stopped')
  expect(native.mock.calls.map(([name]) => name)).toEqual(['browser_begin_agent_action', 'browser_cancel_agent_action'])
})

it('cancels queued native work immediately and rejects late successful completion', async () => {
  const started = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  const native = setup(async (command) => {
    if (command === 'browser_agent_action') {
      started.resolve()
      await completed.promise
    }
  })
  const abort = new AbortController()
  const pending = invokeBrowserAction('tab', action, abort.signal, native as typeof invoke)
  await started.promise
  abort.abort(new Error('Stopped'))
  expect(native).toHaveBeenLastCalledWith('browser_cancel_agent_action', { label: 'tab', operationId: 7 })
  completed.resolve()
  await expect(pending).rejects.toThrow('Stopped')
  expect(native.mock.calls.filter(([command]) => command === 'browser_cancel_agent_action')).toHaveLength(1)
})

it('cleans up after action failure and removes the abort listener on completion', async () => {
  const native = setup(async (command) => {
    if (command === 'browser_agent_action') {
      throw new Error('Stale element')
    }
  })
  const abort = new AbortController()
  await expect(invokeBrowserAction('tab', action, abort.signal, native as typeof invoke)).rejects.toThrow(
    'Stale element',
  )
  abort.abort()
  expect(native).toHaveBeenCalledTimes(3)
})

it('surfaces failed native cancellation instead of claiming control was released', async () => {
  const native = setup(async (command) => {
    if (command === 'browser_cancel_agent_action') {
      throw new Error('Cannot revoke input')
    }
  })
  await expect(invokeBrowserAction('tab', action, undefined, native as typeof invoke)).rejects.toThrow(
    'Cannot revoke input',
  )
})

it('does not dispatch or release input when acquiring a ticket fails', async () => {
  const native = mock(async () => {
    throw new Error('Page closed')
  })
  await expect(invokeBrowserAction('tab', action, undefined, native as typeof invoke)).rejects.toThrow('Page closed')
  expect(native).toHaveBeenCalledTimes(1)
})

it('retains both the operation failure and a failed cancellation', async () => {
  const native = setup(async (command) => {
    throw new Error(command)
  })
  const result = await invokeBrowserAction('tab', action, undefined, native as typeof invoke).catch(
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors.map((error: Error) => error.message)).toEqual([
    'browser_agent_action',
    'browser_cancel_agent_action',
  ])
})
