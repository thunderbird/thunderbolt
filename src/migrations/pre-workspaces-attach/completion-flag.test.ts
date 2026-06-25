/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { isCompletionFlagSet, setCompletionFlag } from './completion-flag'

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
