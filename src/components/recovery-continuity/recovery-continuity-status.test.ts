/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { EncryptionMetadataResponse } from '@shared/e2ee-types'
import {
  phraseUpdateRequired,
  accountNeedsContinuityUpdate,
  derivePasskeyContinuityStatus,
  deriveRecoveryContinuityStatus,
  nextUpdateRequiredCache,
  passkeyNeedsContinuityUpdate,
  type RecoveryContinuityInputs,
} from './recovery-continuity-status'

const metadata = (overrides: Partial<EncryptionMetadataResponse> = {}): EncryptionMetadataResponse => ({
  canary_iv: 'iv',
  canary_ctext: 'ct',
  kdf_salt: 'salt',
  signing_public_key: 'spki',
  recovery_ecdh_public_key: 'recovery-ecdh',
  recovery_mlkem_public_key: 'recovery-mlkem',
  recovery_wrapped_ak: 'recovery-envelope',
  recovery_attestation: 'recovery-attestation',
  recovery_continuity: 'sealed',
  passkey_credential_id: null,
  passkey_ecdh_public_key: null,
  passkey_mlkem_public_key: null,
  passkey_wrapped_ak: null,
  passkey_attestation: null,
  passkey_continuity: null,
  key_version: 1,
  primary_key_id: '0',
  scheme_version: 2,
  ...overrides,
})

const unsealed = metadata({ recovery_continuity: null })
const withPasskey = (passkeyContinuity: string | null) =>
  metadata({ passkey_credential_id: 'credential', passkey_continuity: passkeyContinuity })

/** A backend that predates both columns omits both keys from its response. */
const oldBackend = (): EncryptionMetadataResponse => {
  const {
    recovery_continuity: _recovery,
    passkey_continuity: _passkey,
    ...rest
  } = metadata({
    passkey_credential_id: 'credential',
  })
  return JSON.parse(JSON.stringify(rest))
}

const trusted = { ready: true, unverified: false }

const inputs = (overrides: Partial<RecoveryContinuityInputs> = {}): RecoveryContinuityInputs => ({
  userId: 'user-a',
  trust: trusted,
  isOnline: true,
  metadata: unsealed,
  cachedUpdateRequiredFor: null,
  ...overrides,
})

describe('accountNeedsContinuityUpdate', () => {
  it.each([
    ['an unsealed v2 account', unsealed, true],
    ['a sealed account', metadata(), false],
    ['a v1 account', metadata({ kdf_salt: null, recovery_continuity: null }), false],
    ['an account with no recovery slot', metadata({ recovery_wrapped_ak: null, recovery_continuity: null }), false],
    ['an old backend', oldBackend(), false],
    ['no metadata', null, false],
  ])('is %p → %p', (_label, served, expected) => {
    expect(accountNeedsContinuityUpdate(served)).toBe(expected)
  })
})

describe('passkeyNeedsContinuityUpdate', () => {
  it.each([
    ['a legacy slot', withPasskey(null), true],
    ['a sealed slot', withPasskey('seal'), false],
    ['no slot', metadata(), false],
    ['an old backend', oldBackend(), false],
    ['no metadata', null, false],
  ])('is %p → %p', (_label, served, expected) => {
    expect(passkeyNeedsContinuityUpdate(served)).toBe(expected)
  })
})

describe('phraseUpdateRequired', () => {
  it('prefers this session’s answer, then the cache for this user only', () => {
    expect(phraseUpdateRequired(unsealed, null, 'user-a')).toBe(true)
    expect(phraseUpdateRequired(metadata(), 'user-a', 'user-a')).toBe(false)
    expect(phraseUpdateRequired(undefined, 'user-a', 'user-a')).toBe(true)
    expect(phraseUpdateRequired(undefined, 'user-a', 'user-b')).toBe(false)
    expect(phraseUpdateRequired(undefined, null, null)).toBe(false)
  })
})

describe('nextUpdateRequiredCache', () => {
  it('records the current user when the account needs the update', () => {
    expect(nextUpdateRequiredCache(null, 'user-a', unsealed)).toBe('user-a')
  })

  it('clears only its own user once the seal is confirmed', () => {
    expect(nextUpdateRequiredCache('user-a', 'user-a', metadata())).toBeNull()
    expect(nextUpdateRequiredCache('user-b', 'user-a', metadata())).toBe('user-b')
  })

  it('leaves the cache alone without a v2 response', () => {
    expect(nextUpdateRequiredCache('user-a', 'user-a', null)).toBe('user-a')
    expect(nextUpdateRequiredCache('user-a', 'user-a', metadata({ kdf_salt: null }))).toBe('user-a')
    expect(nextUpdateRequiredCache('user-a', 'user-a', oldBackend())).toBe('user-a')
  })
})

describe('deriveRecoveryContinuityStatus', () => {
  it.each([
    ['hidden with no user', { userId: null }, 'hidden'],
    ['warning for a trusted device online', {}, 'warning'],
    ['hidden once sealed', { metadata: metadata() }, 'hidden'],
    ['offline when the device is offline', { isOnline: false }, 'offline'],
    ['untrusted when the device is not ready', { trust: { ready: false, unverified: false } }, 'untrusted'],
    ['unverified on a marked device', { trust: { ready: true, unverified: true } }, 'unverified'],
    [
      'unverified even on a sealed account',
      { trust: { ready: true, unverified: true }, metadata: metadata() },
      'unverified',
    ],
    ['warning from the cache with no response', { metadata: undefined, cachedUpdateRequiredFor: 'user-a' }, 'warning'],
    ['hidden for another user’s cache', { metadata: undefined, cachedUpdateRequiredFor: 'user-b' }, 'hidden'],
    ['hidden on an old backend', { metadata: oldBackend() }, 'hidden'],
  ] as const)('is %s', (_label, overrides, expected) => {
    expect(deriveRecoveryContinuityStatus(inputs(overrides))).toBe(expected)
  })
})

describe('derivePasskeyContinuityStatus', () => {
  it.each([
    ['none without metadata', { metadata: null }, 'none'],
    ['none without a slot', { metadata: metadata() }, 'none'],
    ['none on an old backend', { metadata: oldBackend() }, 'none'],
    ['protected once sealed', { metadata: withPasskey('seal') }, 'protected'],
    ['needsUpdate for a trusted device online', { metadata: withPasskey(null) }, 'needsUpdate'],
    ['blocked offline', { metadata: withPasskey(null), isOnline: false }, 'blocked'],
    ['blocked untrusted', { metadata: withPasskey(null), trust: { ready: false, unverified: false } }, 'blocked'],
    ['blocked unverified', { metadata: withPasskey(null), trust: { ready: true, unverified: true } }, 'blocked'],
  ] as const)('is %s', (_label, overrides, expected) => {
    expect(derivePasskeyContinuityStatus(inputs(overrides))).toBe(expected)
  })
})
