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

  it('promotes the un-namespaced auth token to the namespaced key and preserves the legacy key', () => {
    localStorage.setItem('thunderbolt_auth_token', 'legacy-token')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: true, migratedDeviceId: false })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('legacy-token')
    // Legacy key is preserved for rollback safety — see local-storage-migration.ts.
    expect(localStorage.getItem('thunderbolt_auth_token')).toBe('legacy-token')
  })

  it('promotes the un-namespaced device id to the namespaced key and preserves the legacy key', () => {
    localStorage.setItem('thunderbolt_device_id', 'legacy-device-id')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: false, migratedDeviceId: true })
    expect(localStorage.getItem(`thunderbolt_device_id__${serverId}`)).toBe('legacy-device-id')
    expect(localStorage.getItem('thunderbolt_device_id')).toBe('legacy-device-id')
  })

  it('promotes both keys when both legacy values are present and leaves both legacy keys in place', () => {
    localStorage.setItem('thunderbolt_auth_token', 'tok')
    localStorage.setItem('thunderbolt_device_id', 'dev')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: true, migratedDeviceId: true })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('tok')
    expect(localStorage.getItem(`thunderbolt_device_id__${serverId}`)).toBe('dev')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBe('tok')
    expect(localStorage.getItem('thunderbolt_device_id')).toBe('dev')
  })

  it('is a no-op when no legacy keys exist (already migrated / fresh install)', () => {
    localStorage.setItem(`thunderbolt_auth_token__${serverId}`, 'already-namespaced')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result).toEqual({ migratedToken: false, migratedDeviceId: false })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('already-namespaced')
  })

  it('preserves the existing namespaced value when both legacy and namespaced are present', () => {
    // Pathological "both present" state — e.g. downgrade/upgrade cycle.
    // The namespaced value belongs to the workspaces build (more recent);
    // keep it. Legacy key is still preserved untouched for rollback.
    localStorage.setItem('thunderbolt_auth_token', 'legacy')
    localStorage.setItem(`thunderbolt_auth_token__${serverId}`, 'new-value')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result.migratedToken).toBe(false)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('new-value')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBe('legacy')
  })

  it('namespaces under the given serverId — running again under a different serverId does not bleed', () => {
    // The legacy un-namespaced token belonged to a single-server pre-Workspaces
    // world. After it's been bound to one `serverId`, the sentinel stops it
    // from being copied into another `serverId`'s namespace — promoting it
    // twice would install someone else's auth into a server's slot.
    const serverA = '00000000-0000-0000-0000-00000000000a'
    const serverB = '00000000-0000-0000-0000-00000000000b'
    localStorage.setItem('thunderbolt_auth_token', 'legacy-A')

    const resultA = migrateLocalStorageIfNeeded(serverA)
    expect(resultA.migratedToken).toBe(true)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverA}`)).toBe('legacy-A')

    const resultB = migrateLocalStorageIfNeeded(serverB)
    expect(resultB.migratedToken).toBe(false)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverB}`)).toBeNull()
    // Legacy key is still around — sentinel just blocks the second promotion.
    expect(localStorage.getItem('thunderbolt_auth_token')).toBe('legacy-A')
  })

  it('is idempotent — calling twice with the same serverId is a no-op', () => {
    localStorage.setItem('thunderbolt_auth_token', 'tok')
    migrateLocalStorageIfNeeded(serverId)

    const result = migrateLocalStorageIfNeeded(serverId)
    expect(result).toEqual({ migratedToken: false, migratedDeviceId: false })
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('tok')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBe('tok')
  })

  it('migrates an empty-string token as a real value (not equivalent to "absent")', () => {
    // Empty-string isn't a token a user would ever have, but localStorage
    // preserves the empty string and the migration must too — otherwise a
    // pathological state could lose the only signal that "we were here."
    localStorage.setItem('thunderbolt_auth_token', '')

    const result = migrateLocalStorageIfNeeded(serverId)

    expect(result.migratedToken).toBe(true)
    expect(localStorage.getItem(`thunderbolt_auth_token__${serverId}`)).toBe('')
    expect(localStorage.getItem('thunderbolt_auth_token')).toBe('')
  })
})
