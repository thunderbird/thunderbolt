/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  isCompletionFlagSet,
  isDataCompletionFlagSet,
  isGlobalCompletionFlagSet,
  setCompletionFlag,
  setDataCompletionFlag,
  setGlobalCompletionFlag,
} from './completion-flag'

const serverA = '00000000-0000-0000-0000-00000000000a'
const serverB = '00000000-0000-0000-0000-00000000000b'

describe('pre-workspaces-attach completion flag', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('returns false when the flag is unset for the given server', () => {
    expect(isCompletionFlagSet(serverA)).toBe(false)
  })

  it('returns true after setCompletionFlag is called for the same server', () => {
    setCompletionFlag(serverA)
    expect(isCompletionFlagSet(serverA)).toBe(true)
  })

  it('is namespaced per server so a flag on one server does not affect another', () => {
    setCompletionFlag(serverA)
    expect(isCompletionFlagSet(serverA)).toBe(true)
    expect(isCompletionFlagSet(serverB)).toBe(false)
  })

  it('writes the literal localStorage key documented in completion-flag.ts', () => {
    setCompletionFlag(serverA)
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverA}`)).toBe('1')
  })

  it('is idempotent across repeated set calls', () => {
    setCompletionFlag(serverA)
    setCompletionFlag(serverA)
    setCompletionFlag(serverA)
    expect(isCompletionFlagSet(serverA)).toBe(true)
  })

  it('does not treat unrelated values for the same key as a set flag', () => {
    // Defensive: a corrupted/legacy value other than the literal '1' must not be
    // mistaken for completion. Without this the migration could silently skip.
    localStorage.setItem(`pre_workspaces_attach_completed__${serverA}`, 'true')
    expect(isCompletionFlagSet(serverA)).toBe(false)
  })
})

describe('pre-workspaces-attach global completion flag', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('returns false when the global flag is unset', () => {
    expect(isGlobalCompletionFlagSet()).toBe(false)
  })

  it('returns true after setGlobalCompletionFlag is called', () => {
    setGlobalCompletionFlag()
    expect(isGlobalCompletionFlagSet()).toBe(true)
  })

  it('writes the un-namespaced localStorage key (no serverId suffix)', () => {
    setGlobalCompletionFlag()
    expect(localStorage.getItem('pre_workspaces_attach_completed')).toBe('1')
  })

  it('is independent of any per-server flag', () => {
    // A set per-server flag must not satisfy the global gate, otherwise the
    // device-wide "legacy consumed" invariant is bypassed via a per-server
    // upgrade running before the device-global one ever fired.
    setCompletionFlag(serverA)
    expect(isGlobalCompletionFlagSet()).toBe(false)
  })

  it('does not treat unrelated values as set', () => {
    localStorage.setItem('pre_workspaces_attach_completed', 'true')
    expect(isGlobalCompletionFlagSet()).toBe(false)
  })
})

describe('pre-workspaces-attach data-completion flag', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('returns false when the data flag is unset for the given server', () => {
    expect(isDataCompletionFlagSet(serverA)).toBe(false)
  })

  it('returns true after setDataCompletionFlag is called for the same server', () => {
    setDataCompletionFlag(serverA)
    expect(isDataCompletionFlagSet(serverA)).toBe(true)
  })

  it('writes the literal localStorage key under the data namespace', () => {
    setDataCompletionFlag(serverA)
    expect(localStorage.getItem(`pre_workspaces_attach_data_completed__${serverA}`)).toBe('1')
  })

  it('is independent of the overall completion flag', () => {
    // The destructive part of the migration sets the data flag without
    // necessarily setting the overall completion flag — that combination
    // signals "queue replacement done, api-key stamp still pending".
    setDataCompletionFlag(serverA)
    expect(isDataCompletionFlagSet(serverA)).toBe(true)
    expect(isCompletionFlagSet(serverA)).toBe(false)
  })
})
