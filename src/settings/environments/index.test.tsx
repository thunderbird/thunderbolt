/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import * as tauri from '@tauri-apps/api/core'
import * as platform from '@/lib/platform'
import * as statusHook from '@/agent-execution/use-ssh-environment-status'
import { useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import EnvironmentsSettingsPage from './index'

const environment: SshEnvironment = {
  id: 'b7384969-0e82-4b21-b9f0-688a5b4ac0ae',
  name: 'OrbStack',
  host: 'orb',
  cwd: '~',
  authentication: 'agent',
  deletedAt: null,
}
beforeEach(() => {
  useSshEnvironmentsStore.setState({ environments: {} })
  // Other suites replace invoke with a shared mock; restoring its spy retains that mock's call history.
  spyOn(tauri, 'invoke').mockClear()
})
afterEach(() => {
  cleanup()
  useSshEnvironmentsStore.setState({ environments: {} })
  mock.restore()
})

it('explains desktop requirements on web without offering a nonfunctional add button', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  render(<EnvironmentsSettingsPage />)
  expect(screen.getByText('SSH requires the desktop app')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Add SSH environment' })).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})

it('shows an accessible green connection indicator and lets users check again', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  const refresh = mock()
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  render(<EnvironmentsSettingsPage />)
  expect(screen.getByRole('status', { name: 'Connected' })).toHaveClass('bg-green-500')
  fireEvent.click(screen.getByRole('button', { name: 'Check connection to OrbStack' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('shows a red status and actionable connection errors', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({
    status: 'disconnected',
    error: 'Host key verification failed.',
    refresh: mock(),
  })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  render(<EnvironmentsSettingsPage />)
  expect(screen.getByRole('status', { name: 'Disconnected' })).toHaveClass('bg-destructive')
  expect(screen.getByText('Host key verification failed.')).toBeInTheDocument()
  expect(
    screen.getByText('Could not connect. Check the address, credentials, trusted host key, and remote working folder.'),
  ).toBeInTheDocument()
})

/** Follow the shared detail-panel removal flow. */
const requestRemoval = () => {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove SSH environment' }))
  return screen.getByRole('alertdialog', { name: 'Remove OrbStack?' })
}

it('removes saved credentials before soft-deleting the environment', async () => {
  const saved = { ...environment, authentication: 'password', hasSecret: true } as const
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh: mock() })
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  useSshEnvironmentsStore.getState().saveEnvironment(saved)
  render(<EnvironmentsSettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit OrbStack' }))
  const confirmation = requestRemoval()
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(within(confirmation).getByRole('button', { name: 'Remove SSH environment' })))
  expect(invoke).toHaveBeenCalledWith('agent_ssh_set_secret', {
    connection: {
      environmentId: environment.id,
      host: 'orb',
      authentication: 'password',
      hasSecret: true,
      username: undefined,
      port: undefined,
      identityFile: undefined,
    },
    secret: null,
  })
  expect(useSshEnvironmentsStore.getState().environments[environment.id].deletedAt).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit OrbStack' })).toBeNull()
})

it('finishes an authorized credential save without dismissing a newer environment editor', async () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh: mock() })
  const saved = { ...environment, authentication: 'password', hasSecret: true } as const
  const other = { ...environment, id: 'a14d6719-131f-483f-b528-936997fd335e', name: 'Other machine' }
  useSshEnvironmentsStore.getState().saveEnvironment(saved)
  useSshEnvironmentsStore.getState().saveEnvironment(other)
  const credential = Promise.withResolvers<void>()
  spyOn(tauri, 'invoke').mockReturnValue(credential.promise)
  render(<EnvironmentsSettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit OrbStack' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Saved name' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'replacement-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit Other machine' }))
  await act(async () => {
    credential.resolve()
    await credential.promise
  })
  expect(useSshEnvironmentsStore.getState().environments[environment.id]).toMatchObject({
    name: 'Saved name',
    hasSecret: true,
  })
  expect(screen.getByLabelText('Name')).toHaveValue('Other machine')
})

it.each(['success', 'failure'] as const)(
  'keeps a newer editor open after a previous removal finishes with %s',
  async (outcome) => {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh: mock() })
    const saved = { ...environment, authentication: 'password', hasSecret: true } as const
    const other = { ...environment, id: 'a14d6719-131f-483f-b528-936997fd335e', name: 'Other machine' }
    useSshEnvironmentsStore.getState().saveEnvironment(saved)
    useSshEnvironmentsStore.getState().saveEnvironment(other)
    const credential = Promise.withResolvers<void>()
    spyOn(tauri, 'invoke').mockReturnValue(credential.promise)
    render(<EnvironmentsSettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit OrbStack' }))
    const confirmation = requestRemoval()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Remove SSH environment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Other machine' }))
    await act(async () => {
      if (outcome === 'success') {
        credential.resolve()
      } else {
        credential.reject(new Error('Keychain locked'))
      }
      await credential.promise.catch(() => {})
    })
    expect(Boolean(useSshEnvironmentsStore.getState().environments[environment.id].deletedAt)).toBe(
      outcome === 'success',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('Other machine')
    expect(screen.queryByRole('alert')).toBeNull()
  },
)

it('shows unchecked connections neutrally and checks only after the user asks', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  const refresh = mock()
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'unchecked', error: null, refresh })
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  render(<EnvironmentsSettingsPage />)
  expect(screen.getByRole('status', { name: 'Not checked' })).toHaveClass('bg-muted-foreground')
  expect(
    screen.queryByText(
      'Check connection to verify this environment. Your SSH agent or system keychain may ask for approval.',
    ),
  ).not.toBeInTheDocument()
  expect(refresh).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Check connection to OrbStack' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('disables the connection check only while a user-requested check is running', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'checking', error: null, refresh: mock() })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  render(<EnvironmentsSettingsPage />)
  expect(screen.getByRole('status', { name: 'Checking connection' })).toHaveClass('bg-muted-foreground')
  expect(screen.getByRole('button', { name: 'Check connection to OrbStack' })).toBeDisabled()
})

it('keeps the empty state minimal with one add action and no explanatory paragraphs', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  render(<EnvironmentsSettingsPage />)
  expect(screen.getByRole('heading', { name: 'No SSH environments' })).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Add SSH environment' })).toHaveLength(1)
  expect(screen.queryByText(/Connect your agent to another machine/)).toBeNull()
  expect(screen.queryByText(/Check connection to verify this environment/)).toBeNull()
  expect(screen.queryByText(/Add an SSH host, an OrbStack machine/)).toBeNull()
})

it('can cancel removal without deleting credentials or the environment', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh: mock() })
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  useSshEnvironmentsStore.getState().saveEnvironment({ ...environment, authentication: 'password', hasSecret: true })
  render(<EnvironmentsSettingsPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit OrbStack' }))
  expect(screen.queryByRole('button', { name: 'Remove SSH environment' })).toBeNull()
  const confirmation = requestRemoval()
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
  expect(useSshEnvironmentsStore.getState().environments[environment.id].deletedAt).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Name')).toHaveValue('OrbStack')
})
