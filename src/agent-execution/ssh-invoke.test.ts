/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'bun:test'
import type { NativeInvoke } from '@shared/agent-core/native-execution-env'
import { createSshInvoke } from './ssh-invoke'
import { sshConnection, useSshEnvironmentsStore } from './ssh-environments'

const profile = {
  id: crypto.randomUUID(),
  name: 'VM',
  host: 'orb',
  cwd: '~',
  authentication: 'agent' as const,
  deletedAt: null,
}
afterEach(() => useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} }))

it.each(['delete', 'retarget'] as const)(
  'cancels an active SSH operation on profile %s and rejects queued operations',
  async (change) => {
    useSshEnvironmentsStore.getState().saveEnvironment(profile)
    const finished = Promise.withResolvers<void>()
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    const native: NativeInvoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args })
      if (command === 'agent_cancel_command') {
        finished.resolve()
      }
      if (command === 'agent_ssh_request') {
        await finished.promise
      }
      return undefined as T
    }
    const invoke = createSshInvoke(sshConnection(profile), native)
    const request = { id: 'command', request: { operation: 'exec', cwd: '~', owner: 'owner' } }
    const result = invoke('agent_ssh_request', request)
    if (change === 'delete') {
      useSshEnvironmentsStore.getState().deleteEnvironment(profile.id)
    } else {
      useSshEnvironmentsStore.getState().saveEnvironment({ ...profile, host: 'another-machine' })
    }
    await expect(result).rejects.toThrow('outcome may be incomplete')
    expect(calls.map(({ command }) => command)).toEqual(['agent_ssh_request', 'agent_cancel_command'])
    expect(calls[1].args.id).toBe('command')
    await expect(invoke('agent_ssh_request', request)).rejects.toThrow('changed or was removed')
    expect(calls).toHaveLength(2)
  },
)

it('does not cancel a command when only the display name changes and unsubscribes after completion', async () => {
  useSshEnvironmentsStore.getState().saveEnvironment(profile)
  const finished = Promise.withResolvers<string>()
  const calls: string[] = []
  const native: NativeInvoke = async <T>(command: string): Promise<T> => {
    calls.push(command)
    return (await finished.promise) as T
  }
  const invoke = createSshInvoke(sshConnection(profile), native)
  const result = invoke('agent_ssh_request', { id: 'command', request: { operation: 'read' } })
  useSshEnvironmentsStore.getState().saveEnvironment({ ...profile, name: 'Renamed' })
  finished.resolve('ok')
  expect(await result).toBe('ok')
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe('connected')
  useSshEnvironmentsStore.getState().deleteEnvironment(profile.id)
  expect(calls).toEqual(['agent_ssh_request'])
})

it.each([
  ['SSH connection failed: Connection refused', 'disconnected'],
  ['Could not start SSH. Install an OpenSSH client', 'disconnected'],
  ['File not found', 'connected'],
] as const)('distinguishes transport failure from a remote file error: %s', async (message, expected) => {
  const store = useSshEnvironmentsStore.getState()
  store.saveEnvironment(profile)
  store.recordConnectionStatus(sshConnection(profile), 'connected')
  const native: NativeInvoke = async () => {
    throw new Error(message)
  }
  await expect(
    createSshInvoke(sshConnection(profile), native)('agent_ssh_request', {
      id: 'read',
      request: { operation: 'read', cwd: '~' },
    }),
  ).rejects.toThrow(message)
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe(expected)
  expect(localStorage.getItem('thunderbolt-ssh-environments-v1')).not.toContain(message)
})

it('does not mark a cancelled command as connected', async () => {
  useSshEnvironmentsStore.getState().saveEnvironment(profile)
  const native: NativeInvoke = async <T>(): Promise<T> => ({ failure: 'aborted', exitCode: -1 }) as T
  await createSshInvoke(sshConnection(profile), native)('agent_ssh_request', {
    id: 'cancelled',
    request: { operation: 'exec', cwd: '~' },
  })
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id]).toBeUndefined()
})

it('keeps a successful tool connected when an older request fails afterward', async () => {
  useSshEnvironmentsStore.getState().saveEnvironment(profile)
  const failed = Promise.withResolvers<unknown>()
  const native: NativeInvoke = async <T>(_command: string, args: Record<string, unknown>): Promise<T> => {
    if (args.id === 'older') {
      return (await failed.promise) as T
    }
    return { stdout: 'done', stderr: '', exitCode: 0 } as T
  }
  const invoke = createSshInvoke(sshConnection(profile), native)
  const older = invoke('agent_ssh_request', { id: 'older', request: { operation: 'read', cwd: '~' } })
  await invoke('agent_ssh_request', { id: 'newer', request: { operation: 'exec', cwd: '~' } })
  failed.reject(new Error('SSH connection failed: Connection refused'))
  await expect(older).rejects.toThrow('Connection refused')
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe('connected')
})

it('forgets local output ownership without reconnecting a removed SSH environment', async () => {
  const calls: Record<string, unknown>[] = []
  const native: NativeInvoke = async <T>(_command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push(args)
    return undefined as T
  }
  await createSshInvoke(sshConnection(profile), native)('agent_ssh_request', {
    id: 'cleanup',
    request: { operation: 'cleanup', owner: 'owner', cwd: '~' },
  })
  expect(calls).toEqual([
    { id: 'cleanup', request: { operation: 'cleanup', owner: 'owner', cwd: '~', forgetOnly: true } },
  ])
})
