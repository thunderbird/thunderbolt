/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import * as tauri from '@tauri-apps/api/core'
import { queryClient } from '@/lib/query-client'
import { sshConnection, useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { useSshEnvironmentFormState } from './use-ssh-environment-form-state'

const environment: SshEnvironment = {
  id: '2e9b9687-cab3-438c-999b-479fa69a6675',
  name: 'Work VM',
  host: 'work-vm',
  cwd: '~/workspace',
  authentication: 'password',
  hasSecret: true,
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

it('saves a new password only in the native credential store and clears the draft', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const saved = mock()
  const { result } = renderHook(() => useSshEnvironmentFormState(undefined, saved))
  act(() => {
    result.current.dispatch({ field: 'name', value: ' Tart ' })
    result.current.dispatch({ field: 'host', value: ' 192.0.2.1 ' })
    result.current.dispatch({ field: 'authentication', value: 'password' })
    result.current.dispatch({ field: 'username', value: 'admin' })
  })
  expect(result.current.valid).toBe(false)
  act(() => result.current.dispatch({ field: 'secret', value: 'private-password' }))
  const id = result.current.id
  await act(async () => result.current.submit())
  const stored = useSshEnvironmentsStore.getState().environments[id]
  expect(stored).toMatchObject({ name: 'Tart', host: '192.0.2.1', username: 'admin', authentication: 'password' })
  expect(invoke).toHaveBeenCalledWith('agent_ssh_set_secret', {
    connection: sshConnection(stored),
    secret: 'private-password',
  })
  expect(JSON.stringify(useSshEnvironmentsStore.getState())).not.toContain('private-password')
  expect(result.current.secret).toBe('')
  expect(saved).toHaveBeenCalledTimes(1)
})

it('renames an existing password environment without reading or replacing the saved password', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const { result } = renderHook(() => useSshEnvironmentFormState(environment, mock()))
  act(() => result.current.dispatch({ field: 'name', value: 'Renamed' }))
  expect(result.current.secretRequired).toBe(false)
  await act(async () => result.current.submit())
  expect(invoke).not.toHaveBeenCalled()
  expect(useSshEnvironmentsStore.getState().environments[environment.id].name).toBe('Renamed')
})

it.each([
  ['host', 'different-vm'],
  ['username', 'another-user'],
  ['port', '2222'],
] as const)('requires a new password when changing %s', async (field, value) => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const { result } = renderHook(() => useSshEnvironmentFormState(environment, mock()))
  act(() => result.current.dispatch({ field, value }))
  expect(result.current.secretRequired).toBe(true)
  expect(result.current.valid).toBe(false)
  await act(async () => result.current.submit())
  expect(invoke).not.toHaveBeenCalled()
  expect(useSshEnvironmentsStore.getState().environments).toEqual({})
})

it('clears the saved credential when switching to agent authentication', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const { result } = renderHook(() => useSshEnvironmentFormState(environment, mock()))
  act(() => {
    result.current.dispatch({ field: 'secret', value: 'draft-password' })
    result.current.dispatch({ field: 'authentication', value: 'agent' })
  })
  expect(result.current.secret).toBe('')
  await act(async () => result.current.submit())
  expect(invoke).toHaveBeenCalledWith('agent_ssh_set_secret', {
    connection: sshConnection({ ...environment, authentication: 'agent', hasSecret: false }),
    secret: null,
  })
})

it('supports a key with an optional native-stored passphrase', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const { result } = renderHook(() => useSshEnvironmentFormState({ ...environment, authentication: 'agent' }, mock()))
  act(() => result.current.dispatch({ field: 'authentication', value: 'key' }))
  expect(result.current.valid).toBe(false)
  act(() => {
    result.current.dispatch({ field: 'identityFile', value: '/Users/me/.ssh/id_ed25519' })
    result.current.dispatch({ field: 'secret', value: 'key-passphrase' })
  })
  await act(async () => result.current.submit())
  expect(invoke).toHaveBeenCalledWith('agent_ssh_set_secret', {
    connection: sshConnection({ ...environment, authentication: 'key', identityFile: '/Users/me/.ssh/id_ed25519' }),
    secret: 'key-passphrase',
  })
})

it('validates metadata before changing an existing credential', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const saved = mock()
  const { result } = renderHook(() => useSshEnvironmentFormState(environment, saved))
  act(() => {
    result.current.dispatch({ field: 'host', value: '-oProxyCommand=bad' })
    result.current.dispatch({ field: 'secret', value: 'replacement' })
  })
  await act(async () => result.current.submit())
  expect(invoke).not.toHaveBeenCalled()
  expect(saved).not.toHaveBeenCalled()
  expect(result.current.error).not.toBeNull()
})

it('does not save the definition when secure credential storage fails', async () => {
  spyOn(tauri, 'invoke').mockRejectedValue(new Error('keychain locked'))
  const saved = mock()
  const { result } = renderHook(() => useSshEnvironmentFormState(environment, saved))
  act(() => result.current.dispatch({ field: 'secret', value: 'replacement' }))
  await act(async () => result.current.submit())
  expect(useSshEnvironmentsStore.getState().environments).toEqual({})
  expect(saved).not.toHaveBeenCalled()
  expect(result.current.error).toContain('Could not save')
  expect(result.current.errorDetail).toBe('Error: keychain locked')
})

it.each(['0', '-1', '65536', '1.5'])('rejects invalid port %s without side effects', async (port) => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const { result } = renderHook(() => useSshEnvironmentFormState({ ...environment, authentication: 'agent' }, mock()))
  act(() => result.current.dispatch({ field: 'port', value: port }))
  expect(result.current.valid).toBe(false)
  await act(async () => result.current.submit())
  expect(invoke).not.toHaveBeenCalled()
})

it('can remove a saved key passphrase without changing the connection', async () => {
  const invoke = spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const keyEnvironment = { ...environment, authentication: 'key', identityFile: '/tmp/id_ed25519' } as const
  const { result } = renderHook(() => useSshEnvironmentFormState(keyEnvironment, mock()))
  act(() => result.current.dispatch({ field: 'clearSavedSecret', value: true }))
  await act(async () => result.current.submit())
  expect(invoke).toHaveBeenCalledWith('agent_ssh_set_secret', {
    connection: sshConnection({ ...keyEnvironment, hasSecret: false }),
    secret: null,
  })
})

it('does not require a secure credential service to save a config-and-agent connection', async () => {
  const invoke = spyOn(tauri, 'invoke').mockRejectedValue(new Error('No keychain service'))
  const { result } = renderHook(() => useSshEnvironmentFormState(undefined, mock()))
  act(() => {
    result.current.dispatch({ field: 'name', value: 'OrbStack' })
    result.current.dispatch({ field: 'host', value: 'orb' })
  })
  await act(async () => result.current.submit())
  expect(invoke).not.toHaveBeenCalled()
  expect(useSshEnvironmentsStore.getState().environments[result.current.id].name).toBe('OrbStack')
})

it('resets previous connection health after replacing only a saved password', async () => {
  spyOn(tauri, 'invoke').mockResolvedValue(undefined)
  const reset = spyOn(queryClient, 'resetQueries').mockResolvedValue(undefined)
  const { result } = renderHook(() => useSshEnvironmentFormState(environment, mock()))
  act(() => result.current.dispatch({ field: 'secret', value: 'replacement' }))
  await act(async () => result.current.submit())
  expect(reset).toHaveBeenCalledWith({
    queryKey: ['ssh-environment-status', JSON.stringify(sshConnection(environment))],
  })
})
