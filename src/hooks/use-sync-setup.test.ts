/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EncryptionMetadataResponse } from '@shared/e2ee-types'
import { describe, expect, it } from 'bun:test'
import { classifyEncryptionMetadata, reducer, initialState } from './use-sync-setup'

const metadata = (schemeVersion: 1 | 2): EncryptionMetadataResponse => ({
  canary_iv: 'iv',
  canary_ctext: 'ct',
  kdf_salt: schemeVersion === 2 ? 'salt' : null,
  signing_public_key: schemeVersion === 2 ? 'spki' : null,
  key_version: 1,
  primary_key_id: '0',
  scheme_version: schemeVersion,
})

describe('classifyEncryptionMetadata', () => {
  it('returns "none" when there is no metadata (404)', () => {
    expect(classifyEncryptionMetadata(null)).toBe('none')
  })

  it('returns "v1" for a legacy scheme_version === 1 account', () => {
    expect(classifyEncryptionMetadata(metadata(1))).toBe('v1')
  })

  it('returns "v2" for a migrated scheme_version === 2 account', () => {
    expect(classifyEncryptionMetadata(metadata(2))).toBe('v2')
  })
})

describe('useSyncSetup reducer', () => {
  it('routes a migration into the recovery-key display step', () => {
    const next = reducer(initialState, { type: 'SET_RECOVERY_KEY', payload: 'word '.repeat(24).trim() })
    expect(next.step).toBe('recovery-key-display')
    expect(next.recoveryKey).toContain('word')
    expect(next.isLoading).toBe(false)
  })

  it('sends an additional device to the approval-waiting step', () => {
    const next = reducer(initialState, { type: 'DETECTED_ADDITIONAL_DEVICE' })
    expect(next.step).toBe('approval-waiting')
  })

  it('sends a first device to first-device-setup', () => {
    const next = reducer(initialState, { type: 'DETECTED_FIRST_DEVICE' })
    expect(next.step).toBe('first-device-setup')
  })
})
