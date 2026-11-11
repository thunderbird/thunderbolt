/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import * as tauri from '@tauri-apps/api/core'
import * as platform from '@/lib/platform'
import type { SshDirectoryListing, SshRequest } from '@shared/agent-core/ssh-transport'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import { SshFolderInput } from './ssh-folder-input'

const environment = {
  id: 'edfa69dd-fe35-4bbe-a745-026769cbb913',
  name: 'Remote',
  host: 'orb',
  cwd: '~',
  authentication: 'agent' as const,
  deletedAt: null,
}
const home: SshDirectoryListing = {
  path: '/home/chris',
  parentPath: '/home',
  directories: [
    { name: 'My projects', path: '/home/chris/My projects' },
    { name: 'Documents', path: '/home/chris/Documents' },
  ],
}

beforeEach(() => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(tauri, 'invoke').mockClear()
  useSshEnvironmentsStore.setState({ environments: {} })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
})
afterEach(() => {
  cleanup()
  mock.restore()
  useSshEnvironmentsStore.setState({ environments: {} })
})

/** Drain React Query updates without advancing a connection timeout. */
const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(50)
  })
}

/** Record structured directory requests without running SSH. */
const mockListing = (read: (request: SshRequest) => Promise<SshDirectoryListing>) =>
  spyOn(tauri, 'invoke').mockImplementation(async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    return (command === 'agent_ssh_request' ? await read(args?.request as SshRequest) : undefined) as T
  })

const mount = (onChange = mock((_path: string) => {})) => {
  render(<SshFolderInput id="remote-folder" environmentId={environment.id} value="~" onChange={onChange} />, {
    wrapper: createQueryTestWrapper(),
  })
  return onChange
}

it('browses and filters remote directories only after an explicit click, then confirms the canonical path', async () => {
  const requests: SshRequest[] = []
  const invoke = mockListing(async (request) => {
    requests.push(request)
    return request.cwd === '~' ? home : { path: request.cwd, parentPath: '/home/chris', directories: [] }
  })
  const onChange = mount()
  await settle()
  expect(invoke).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '~/manual' } })
  expect(onChange).toHaveBeenCalledWith('~/manual')
  expect(invoke).not.toHaveBeenCalled()
  onChange.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Browse remote folders' }))
  await settle()
  expect(requests).toEqual([expect.objectContaining({ operation: 'list_directories', cwd: '~' })])
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a folder' }), { target: { value: 'proj' } })
  expect(screen.queryByRole('button', { name: 'Documents' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'My projects' }))
  await settle()
  expect(requests[1]).toMatchObject({ operation: 'list_directories', cwd: '/home/chris/My projects' })
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
  expect(onChange).toHaveBeenCalledWith('/home/chris/My projects')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('offers retry after a failed listing and supports navigating to the parent and home folders', async () => {
  const requests: SshRequest[] = []
  mockListing(async (request) => {
    requests.push(request)
    if (requests.length === 1) {
      throw new Error('Permission denied')
    }
    return request.cwd === '~' ? home : { path: '/', parentPath: null, directories: [] }
  })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Browse remote folders' }))
  await settle()
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load this folder.')
  expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
  await settle()
  expect(requests.at(-1)?.cwd).toBe('/home')
  expect(screen.getByRole('button', { name: 'Parent folder' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Home folder' }))
  await settle()
  expect(screen.getByRole('button', { name: 'Documents' })).toBeInTheDocument()
})

it('cancels an in-flight listing on dismissal without changing the folder', async () => {
  const pending = Promise.withResolvers<SshDirectoryListing>()
  const invoke = mockListing(async () => pending.promise)
  const onChange = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Browse remote folders' }))
  await settle()
  expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await settle()
  expect(invoke.mock.calls.some(([command]) => command === 'agent_cancel_command')).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => {
    pending.resolve(home)
    await pending.promise
  })
})

it('disables selecting a cached folder when the SSH environment is removed', async () => {
  mockListing(async () => home)
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Browse remote folders' }))
  await settle()
  await act(async () => {
    useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
  })
  expect(screen.getByRole('alert')).toHaveTextContent('This SSH environment is unavailable on this computer.')
  expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled()
})
