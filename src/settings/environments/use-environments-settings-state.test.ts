/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import * as tauri from '@tauri-apps/api/core'
import { sshConnection, useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { useEnvironmentsSettingsState } from './use-environments-settings-state'

const environment: SshEnvironment = {
  id: 'b7384969-0e82-4b21-b9f0-688a5b4ac0ae',
  name: 'Work VM',
  host: 'work-vm',
  cwd: '~/workspace',
  authentication: 'password',
  hasSecret: true,
  deletedAt: null,
}

beforeEach(() => {
  useSshEnvironmentsStore.setState({ environments: { [environment.id]: environment } })
  spyOn(tauri, 'invoke').mockClear()
})

afterEach(() => {
  cleanup()
  useSshEnvironmentsStore.setState({ environments: {} })
  mock.restore()
})

it('does not remove the environment until its saved credential is deleted', async () => {
  const deletion = Promise.withResolvers<void>()
  const invoke = spyOn(tauri, 'invoke').mockReturnValue(deletion.promise)
  const { result } = renderHook(useEnvironmentsSettingsState)
  act(() => {
    result.current.open(environment.id)
    result.current.requestRemoval(environment)
  })
  act(() => result.current.confirmRemoval())
  expect(invoke).toHaveBeenCalledWith('agent_ssh_set_secret', {
    connection: sshConnection(environment),
    secret: null,
  })
  expect(result.current.removal).toBeNull()
  expect(result.current.pending).toBe(true)
  expect(result.current.visible).toEqual([environment])
  expect(useSshEnvironmentsStore.getState().environments[environment.id].deletedAt).toBeNull()

  await act(async () => deletion.resolve())
  expect(useSshEnvironmentsStore.getState().environments[environment.id].deletedAt).not.toBeNull()
  expect(result.current.visible).toEqual([])
  expect(result.current.pending).toBe(false)
  expect(result.current.panel).toBeNull()
})

it('keeps the saved environment and reports a credential failure in its editor', async () => {
  spyOn(tauri, 'invoke').mockRejectedValue(new Error('Keychain unavailable: sensitive native details'))
  const { result } = renderHook(useEnvironmentsSettingsState)
  act(() => {
    result.current.open(environment.id)
    result.current.requestRemoval(environment)
  })
  await act(async () => result.current.confirmRemoval())
  expect(useSshEnvironmentsStore.getState().environments[environment.id]).toEqual(environment)
  expect(result.current.active).toEqual(environment)
  expect(result.current.error).toBe('Could not remove this SSH environment. Please try again.')
  expect(result.current.pending).toBe(false)
  act(() => result.current.open('new'))
  expect(result.current.error).toBeNull()
})

it.each(['success', 'failure'] as const)(
  'does not replace a newer selection when credential removal finishes with %s',
  async (outcome) => {
    const deletion = Promise.withResolvers<void>()
    spyOn(tauri, 'invoke').mockReturnValue(deletion.promise)
    const { result } = renderHook(useEnvironmentsSettingsState)
    act(() => {
      result.current.open(environment.id)
      result.current.requestRemoval(environment)
    })
    act(() => result.current.confirmRemoval())
    act(() => result.current.open('new'))
    await act(async () => {
      if (outcome === 'success') {
        deletion.resolve()
      } else {
        deletion.reject(new Error('Keychain locked'))
      }
    })
    expect(result.current.panel).toBe('new')
    expect(result.current.error).toBeNull()
    expect(Boolean(useSshEnvironmentsStore.getState().environments[environment.id].deletedAt)).toBe(
      outcome === 'success',
    )
  },
)

it('soft-deletes an agent-only environment without accessing the credential store', async () => {
  const saved = { ...environment, authentication: 'agent', hasSecret: false } as const
  useSshEnvironmentsStore.getState().saveEnvironment(saved)
  const invoke = spyOn(tauri, 'invoke')
  const { result } = renderHook(useEnvironmentsSettingsState)
  act(() => result.current.requestRemoval(saved))
  await act(async () => result.current.confirmRemoval())
  expect(invoke).not.toHaveBeenCalled()
  expect(useSshEnvironmentsStore.getState().environments[environment.id]).toMatchObject({
    ...saved,
    deletedAt: expect.any(String),
  })
})

it('canceling removal leaves both the saved credential and the environment untouched', async () => {
  const invoke = spyOn(tauri, 'invoke')
  const { result } = renderHook(useEnvironmentsSettingsState)
  act(() => result.current.requestRemoval(environment))
  act(() => result.current.cancelRemoval())
  await act(async () => result.current.confirmRemoval())
  expect(result.current.removal).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
  expect(useSshEnvironmentsStore.getState().environments[environment.id]).toEqual(environment)
})
