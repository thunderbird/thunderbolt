/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as tauri from '@tauri-apps/api/core'
import { getClock } from '@/testing-library'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { SshDiscoveryDialog } from './ssh-discovery-dialog'

const hosts = [
  { id: 'ssh:tartvm', name: 'tartvm', source: 'SSH config', host: 'tartvm', username: null, port: null },
  { id: 'orb:ubuntu', name: 'ubuntu', source: 'OrbStack', host: 'orb', username: 'ubuntu', port: null },
  { id: 'tart:stopped', name: 'Stopped VM', source: 'Tart', host: null, username: null, port: null },
]
beforeEach(() => {
  spyOn(tauri, 'invoke').mockClear()
  useSshEnvironmentsStore.setState({ environments: {} })
})
afterEach(() => {
  cleanup()
  mock.restore()
  useSshEnvironmentsStore.setState({ environments: {} })
})

it('lists discovered hosts and adds selected connections without authenticating or starting VMs', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(hosts)
  const onClose = mock()
  render(<SshDiscoveryDialog onClose={onClose} onManual={mock()} />, { wrapper: createQueryTestWrapper() })
  expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  await act(async () => {
    await getClock().tickAsync(5)
  })
  expect(screen.getByRole('checkbox', { name: 'Stopped VM' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'tartvm' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'ubuntu' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(Object.values(useSshEnvironmentsStore.getState().environments)).toEqual([
    expect.objectContaining({ name: 'tartvm', host: 'tartvm', authentication: 'agent' }),
    expect.objectContaining({ name: 'ubuntu', host: 'orb', username: 'ubuntu' }),
  ])
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(['agent_ssh_discover'])
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('keeps manual entry available when discovery fails and allows refreshing', async () => {
  const invoke = spyOn(tauri, 'invoke').mockRejectedValue(new Error('Inventory unavailable'))
  const manual = mock()
  render(<SshDiscoveryDialog onClose={mock()} onManual={manual} />, { wrapper: createQueryTestWrapper() })
  await act(async () => {
    await getClock().tickAsync(5)
  })
  expect(screen.getByRole('alert')).toHaveTextContent('Could not discover SSH connections')
  fireEvent.click(screen.getByRole('button', { name: 'Add manually' }))
  expect(manual).toHaveBeenCalledTimes(1)
  invoke.mockResolvedValue(hosts)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh SSH connections' }))
    await getClock().tickAsync(5)
  })
  expect(screen.getByRole('checkbox', { name: 'tartvm' })).toBeEnabled()
})

it('excludes already saved destinations while allowing a previously removed one to be added again', async () => {
  spyOn(tauri, 'invoke').mockResolvedValue(hosts)
  const id = crypto.randomUUID()
  useSshEnvironmentsStore
    .getState()
    .saveEnvironment({ id, name: 'Renamed', host: 'tartvm', authentication: 'agent', cwd: '~', deletedAt: null })
  render(<SshDiscoveryDialog onClose={mock()} onManual={mock()} />, { wrapper: createQueryTestWrapper() })
  await act(async () => {
    await getClock().tickAsync(5)
  })
  expect(screen.queryByRole('checkbox', { name: 'tartvm' })).toBeNull()
  act(() => useSshEnvironmentsStore.getState().deleteEnvironment(id))
  expect(screen.getByRole('checkbox', { name: 'tartvm' })).toBeEnabled()
})
