/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  isWorkspacePermissionKey,
  isWorkspacePermissionRole,
  permissionAllows,
  workspacePermissionKeys,
} from './workspaces'

describe('permissionAllows', () => {
  it('admin satisfies admin requirements', () => {
    expect(permissionAllows('admin', 'admin')).toBe(true)
  })

  it('admin satisfies member requirements', () => {
    expect(permissionAllows('admin', 'member')).toBe(true)
  })

  it('member satisfies member requirements', () => {
    expect(permissionAllows('member', 'member')).toBe(true)
  })

  it('member does not satisfy admin requirements', () => {
    expect(permissionAllows('member', 'admin')).toBe(false)
  })

  it('null/undefined user roles never satisfy anything', () => {
    expect(permissionAllows(null, 'admin')).toBe(false)
    expect(permissionAllows(null, 'member')).toBe(false)
    expect(permissionAllows(undefined, 'admin')).toBe(false)
    expect(permissionAllows(undefined, 'member')).toBe(false)
  })
})

describe('isWorkspacePermissionKey', () => {
  it('accepts every key declared in workspacePermissionKeys', () => {
    for (const key of workspacePermissionKeys) {
      expect(isWorkspacePermissionKey(key)).toBe(true)
    }
  })

  it('rejects unknown strings and non-strings', () => {
    expect(isWorkspacePermissionKey('unknown_key')).toBe(false)
    expect(isWorkspacePermissionKey('')).toBe(false)
    expect(isWorkspacePermissionKey(123)).toBe(false)
    expect(isWorkspacePermissionKey(null)).toBe(false)
    expect(isWorkspacePermissionKey(undefined)).toBe(false)
  })
})

describe('isWorkspacePermissionRole', () => {
  it('accepts admin and member', () => {
    expect(isWorkspacePermissionRole('admin')).toBe(true)
    expect(isWorkspacePermissionRole('member')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isWorkspacePermissionRole('owner')).toBe(false)
    expect(isWorkspacePermissionRole('')).toBe(false)
    expect(isWorkspacePermissionRole(null)).toBe(false)
  })
})
