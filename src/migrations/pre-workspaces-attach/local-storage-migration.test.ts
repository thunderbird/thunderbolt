/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { migrateLocalStorageIfNeeded } from './local-storage-migration'

const serverId = '00000000-0000-0000-0000-00000000abcd'

describe('migrateLocalStorageIfNeeded', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('promotes the un-namespaced auth token to the namespaced key and deletes the legacy key', () => {
    localStorage.setItem('thunderbolt_auth_token', 'legacy-token')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: true, migratedDeviceId: false })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('legacy-token')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBeNull()
  })

  it('promotes the un-namespaced device id to the namespaced key and deletes the legacy key', () => {
    localStorage.setItem('thunderbolt_device_id', 'legacy-device-id')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: false, migratedDeviceId: true })
    expect(localStorage.getItem(`thunderbolt_device_id__${serverId}`)).toBe('legacy-device-id')
    expect(localStorage.getItem('thunderbolt_device_id')).toBeNull()
  })

  it('promotes both keys when both legacy values are present', () => {
    localStorage.setItem('thunderbolt_auth_token', 'tok')
    localStorage.setItem('thunderbolt_device_id', 'dev')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: true, migratedDeviceId: true })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('tok')
    expect(localStorage.getItem(`thunderbolt_device_id__${serverId}`)).toBe('dev')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBeNull()
    expect(localStorage.getItem('thunderbolt_device_id')).toBeNull()
  })

  it('is a no-op when no legacy keys exist (already migrated / fresh install)', () => {
    localStorage.setItem(`thunderbolt_auth_token__${serverId}`, 'already-namespaced')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: false, migratedDeviceId: false })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('already-namespaced')
  })

  it('preserves the existing namespaced value and still drops the legacy key when both are present', () => {
    // Pathological "both present" state — e.g. downgrade/upgrade cycle.
    // The namespaced value belongs to the workspaces build (more recent);
    // keep it and discard the legacy duplicate.
    localStorage.setItem('thunderbolt_auth_token', 'legacy')
    localStorage.setItem(`thunderbolt_auth_token__${serverId}`, 'new-value')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result.migratedToken).toBe(false)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('new-value')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBeNull()
  })

  it('namespaces under the given serverId — running again under a different serverId does not bleed', () => {
    const serverA = '00000000-0000-0000-0000-00000000000a'
    const serverB = '00000000-0000-0000-0000-00000000000b'
    localStorage.setItem('thunderbolt_auth_token', 'legacy-A')

    const resultA = migrateLocalStorageIfNeeded(serverA)
    expect(resultA.migratedToken).toBe(true)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverA}`)).toBe('legacy-A')

    // Legacy key has been cleared, so re-running against serverB is a no-op —
    // serverB's namespace must not inherit serverA's promoted value.
    const resultB = migrateLocalStorageIfNeeded(serverB)
    expect(resultB.migratedToken).toBe(false)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverB}`)).toBeNull()
  })

  it('is idempotent — calling twice with no legacy keys is a no-op', () => {
    localStorage.setItem('thunderbolt_auth_token', 'tok')
    migrateLocalStorageIfNeeded(serverId)

    const result = migrateLocalStorageIfNeeded(serverId)
    expect(result).toEqual({ migratedToken: false, migratedDeviceId: false })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('tok')
  })

  it('migrates an empty-string token as a real value (not equivalent to "absent")', () => {
    // Empty-string isn't a token a user would ever have, but localStorage
    // preserves the empty string and the migration must too — otherwise a
    // pathological state could lose the only signal that "we were here."
    localStorage.setItem('thunderbolt_auth_token', '')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result.migratedToken).toBe(true)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBeNull()
  })
})
