/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { getSshEnvironment, sshConnection, useSshEnvironmentsStore, type SshEnvironment } from './ssh-environments'

const environment = (): SshEnvironment => ({
  id: crypto.randomUUID(),
  name: 'OrbStack',
  host: 'orb',
  username: 'chris@ubuntu',
  authentication: 'agent',
  cwd: '~/project',
  deletedAt: null,
})
afterEach(() => useSshEnvironmentsStore.setState({ environments: {} }))
beforeEach(() => useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} }))

it('persists connection metadata while stripping unrecognized secret fields', () => {
  const profile = { ...environment(), password: 'not-for-localStorage', passphrase: 'not-for-localStorage' }
  useSshEnvironmentsStore.getState().saveEnvironment(profile)
  expect(getSshEnvironment(profile.id)).not.toHaveProperty('password')
  expect(localStorage.getItem('thunderbolt-ssh-environments-v1')).not.toContain('not-for-localStorage')
  expect(sshConnection(getSshEnvironment(profile.id))).toEqual({
    environmentId: profile.id,
    host: 'orb',
    username: 'chris@ubuntu',
    authentication: 'agent',
    port: undefined,
    identityFile: undefined,
    hasSecret: undefined,
  })
})

it('soft deletes a profile without rebinding projects to another profile with the same name', () => {
  const first = environment()
  const second = environment()
  useSshEnvironmentsStore.getState().saveEnvironment(first)
  useSshEnvironmentsStore.getState().deleteEnvironment(first.id)
  useSshEnvironmentsStore.getState().saveEnvironment(second)
  expect(() => getSshEnvironment(first.id)).toThrow('unavailable')
  expect(useSshEnvironmentsStore.getState().environments[first.id].deletedAt).not.toBeNull()
  expect(getSshEnvironment(second.id)).toEqual(second)
})

it('persists verified connection status independently of display names and working folders', () => {
  const profile = environment()
  const store = useSshEnvironmentsStore.getState()
  store.saveEnvironment(profile)
  store.recordConnectionStatus(sshConnection(profile), 'connected')
  const persisted = JSON.parse(localStorage.getItem('thunderbolt-ssh-environments-v1')!)
  expect(persisted.state.connectionStatuses[profile.id]).toMatchObject({ status: 'connected', checkedAt: Date.now() })
  store.saveEnvironment({ ...profile, name: 'Renamed' })
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe('connected')
  store.saveEnvironment({ ...profile, cwd: '/another-folder' })
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe('connected')
})

it('does not let an older failure overwrite newer successful connection evidence', () => {
  const profile = environment()
  const connection = sshConnection(profile)
  const store = useSshEnvironmentsStore.getState()
  store.saveEnvironment(profile)
  const unchecked = useSshEnvironmentsStore.getState().connectionStatuses[profile.id]
  store.recordConnectionStatus(connection, 'connected')
  const connected = useSshEnvironmentsStore.getState().connectionStatuses[profile.id]
  store.recordConnectionStatus(connection, 'disconnected', unchecked)
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id]).toBe(connected)

  store.recordConnectionStatus(connection, 'connected')
  store.recordConnectionStatus(connection, 'disconnected', connected)
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe('connected')

  const current = useSshEnvironmentsStore.getState().connectionStatuses[profile.id]
  store.recordConnectionStatus(connection, 'disconnected', current)
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id].status).toBe('disconnected')
})

it('rejects health updates from a removed or retargeted connection', () => {
  const profile = environment()
  const store = useSshEnvironmentsStore.getState()
  store.saveEnvironment(profile)
  store.saveEnvironment({ ...profile, host: 'other-host' })
  store.recordConnectionStatus(sshConnection(profile), 'connected')
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id]).toBeUndefined()
  store.deleteEnvironment(profile.id)
  store.recordConnectionStatus(sshConnection({ ...profile, host: 'other-host' }), 'connected')
  expect(useSshEnvironmentsStore.getState().connectionStatuses[profile.id]).toBeUndefined()
})

it.each(['-oProxyCommand=evil', 'host;touch /tmp/file', 'host\nother', 'user@host', '$(whoami)'])(
  'rejects unsafe host %s',
  (host) => {
    expect(() => useSshEnvironmentsStore.getState().saveEnvironment({ ...environment(), host })).toThrow()
  },
)

it.each([0, 65536, 1.5, NaN])('rejects invalid port %s before changing saved state', (port) => {
  expect(() => useSshEnvironmentsStore.getState().saveEnvironment({ ...environment(), port })).toThrow()
  expect(useSshEnvironmentsStore.getState().environments).toEqual({})
})

it('requires a selected key for explicit private-key authentication', () => {
  expect(() =>
    useSshEnvironmentsStore.getState().saveEnvironment({ ...environment(), authentication: 'key' }),
  ).toThrow()
})

it.each(['::1', '2001:db8::1', '[::1]', 'vm.example.com'])('accepts an IPv6 literal or hostname: %s', (host) => {
  const profile = { ...environment(), host }
  useSshEnvironmentsStore.getState().saveEnvironment(profile)
  expect(getSshEnvironment(profile.id).host).toBe(host)
})
