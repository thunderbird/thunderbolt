/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { canCreateWorkspace } from './use-can-create-workspace'

describe('canCreateWorkspace', () => {
  it('returns false when no session is loaded', () => {
    expect(canCreateWorkspace({ hasSession: false, isAnonymous: false, config: {} })).toBe(false)
  })

  it('returns true for real user with default (unset) flags', () => {
    expect(canCreateWorkspace({ hasSession: true, isAnonymous: false, config: {} })).toBe(true)
  })

  it('returns true for anonymous user with default (unset) flags', () => {
    expect(canCreateWorkspace({ hasSession: true, isAnonymous: true, config: {} })).toBe(true)
  })

  it('returns false for real user when allowWorkspaceCreationByMembers === false', () => {
    expect(
      canCreateWorkspace({
        hasSession: true,
        isAnonymous: false,
        config: { allowWorkspaceCreationByMembers: false },
      }),
    ).toBe(false)
  })

  it('returns true for real user when allowWorkspaceCreationByMembers === true', () => {
    expect(
      canCreateWorkspace({
        hasSession: true,
        isAnonymous: false,
        config: { allowWorkspaceCreationByMembers: true },
      }),
    ).toBe(true)
  })

  it('returns false for anonymous user when allowWorkspaceCreationByAnon === false', () => {
    expect(
      canCreateWorkspace({
        hasSession: true,
        isAnonymous: true,
        config: { allowWorkspaceCreationByAnon: false },
      }),
    ).toBe(false)
  })

  it('returns true for anonymous user when allowWorkspaceCreationByAnon === true', () => {
    expect(
      canCreateWorkspace({
        hasSession: true,
        isAnonymous: true,
        config: { allowWorkspaceCreationByAnon: true },
      }),
    ).toBe(true)
  })

  it('only the members flag affects real users (anon flag is irrelevant)', () => {
    expect(
      canCreateWorkspace({
        hasSession: true,
        isAnonymous: false,
        config: { allowWorkspaceCreationByAnon: false, allowWorkspaceCreationByMembers: true },
      }),
    ).toBe(true)
  })

  it('only the anon flag affects anonymous users (members flag is irrelevant)', () => {
    expect(
      canCreateWorkspace({
        hasSession: true,
        isAnonymous: true,
        config: { allowWorkspaceCreationByAnon: true, allowWorkspaceCreationByMembers: false },
      }),
    ).toBe(true)
  })
})
