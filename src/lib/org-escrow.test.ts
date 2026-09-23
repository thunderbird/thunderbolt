/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { pinnedOrgEscrowPublicKey } from './org-escrow'

const env = import.meta.env as Record<string, unknown>

describe('pinnedOrgEscrowPublicKey', () => {
  let saved: unknown

  beforeEach(() => {
    saved = env.VITE_ORG_ESCROW_PUBLIC_KEY
  })

  afterEach(() => {
    env.VITE_ORG_ESCROW_PUBLIC_KEY = saved
  })

  it('returns the pinned key when set', () => {
    env.VITE_ORG_ESCROW_PUBLIC_KEY = 'BNPkxi77YSUg'
    expect(pinnedOrgEscrowPublicKey()).toBe('BNPkxi77YSUg')
  })

  it('trims surrounding whitespace a build pipeline may introduce', () => {
    env.VITE_ORG_ESCROW_PUBLIC_KEY = '  BNPkxi77YSUg\n'
    expect(pinnedOrgEscrowPublicKey()).toBe('BNPkxi77YSUg')
  })

  // Unset / blank must read as "this build escrows nothing" rather than as an
  // empty pin: `buildOrgEnvelope` branches on undefined and would otherwise hand
  // an empty string to importOrgPublicKey.
  it('returns undefined when unset', () => {
    env.VITE_ORG_ESCROW_PUBLIC_KEY = undefined
    expect(pinnedOrgEscrowPublicKey()).toBeUndefined()
  })

  it('returns undefined for an empty or whitespace-only value', () => {
    env.VITE_ORG_ESCROW_PUBLIC_KEY = ''
    expect(pinnedOrgEscrowPublicKey()).toBeUndefined()
    env.VITE_ORG_ESCROW_PUBLIC_KEY = '   '
    expect(pinnedOrgEscrowPublicKey()).toBeUndefined()
  })
})
