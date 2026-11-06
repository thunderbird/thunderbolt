/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@/i18n'
import {
  AKAnchorError,
  LockoutIncompleteError,
  MissingRecoverySlotError,
  RecoveryAnchorError,
  StaleKeyMaterialError,
} from '@/services/encryption'
import { describe, expect, it } from 'bun:test'
import { describeRevokeFailure } from './revoke-failure'

// Assert on the resolved string rather than the descriptor: that is what a user
// reads, and it holds under both the real macro (descriptor -> catalog lookup)
// and the bun-test identity macro (source string echoed back by `i18n._`).
const describeMessage = (err: unknown): string => i18n._(describeRevokeFailure(err).message)

describe('describeRevokeFailure', () => {
  describe('the phase it reports', () => {
    it('says nothing was applied when the failure is pre-cut', () => {
      expect(describeMessage(new Error('socket hung up'))).toBe('Nothing was changed. The device was not revoked.')
      expect(describeRevokeFailure(new Error('socket hung up')).action).toBe('retry')
    })

    it('says access is gone but the key is not, when the cut already committed', () => {
      const err = new LockoutIncompleteError({ cause: new Error('socket hung up') })
      expect(describeMessage(err)).toBe(
        'The device lost access, but your account key was not replaced, so it can still read your data.',
      )
      // Never a re-revoke — the device is already revoked, so only the rotation is owed.
      expect(describeRevokeFailure(err).action).toBe('finishLockout')
    })

    it('keeps the phase clause when a wedge cause is named', () => {
      const preCut = describeMessage(new RecoveryAnchorError())
      const postCut = describeMessage(new LockoutIncompleteError({ cause: new RecoveryAnchorError() }))

      expect(preCut).toStartWith('Nothing was changed —')
      expect(postCut).toStartWith('The device lost access, but your account key was not replaced,')
      // Same cause, opposite claim about whether the cut landed.
      expect(preCut).not.toBe(postCut)
    })
  })

  describe('whole sentences, never assembled', () => {
    const everyOutcome = [
      new StaleKeyMaterialError(),
      new Error('socket hung up'),
      new RecoveryAnchorError(),
      new AKAnchorError('unopenable'),
      new MissingRecoverySlotError(),
      new LockoutIncompleteError({ cause: new Error('socket hung up') }),
      new LockoutIncompleteError({ cause: new RecoveryAnchorError() }),
      new LockoutIncompleteError({ cause: new AKAnchorError('material-mismatch') }),
      new LockoutIncompleteError({ cause: new MissingRecoverySlotError() }),
    ]

    it('resolves every outcome to a distinct, self-contained sentence', () => {
      const messages = everyOutcome.map(describeMessage)
      expect(new Set(messages).size).toBe(everyOutcome.length)
      for (const message of messages) {
        expect(message).toEndWith('.')
        // A fragment glued on at render time would show up as a lone dash or a
        // dangling clause; every message is one catalog entry ending in prose.
        expect(message).not.toEndWith('—')
      }
    })
  })

  describe('the causes it names as possible tampering', () => {
    it('names a served recovery anchor that did not verify (THU-865)', () => {
      const failure = describeRevokeFailure(new RecoveryAnchorError())
      expect(i18n._(failure.message)).toBe(
        'Nothing was changed — the recovery keys the server offered could not be verified against this device. ' +
          'This can indicate tampering.',
      )
      expect(failure.action).toBe('phraseChange')
    })

    it('names a served account key this device refused (THU-869)', () => {
      const failure = describeRevokeFailure(new AKAnchorError('material-mismatch'))
      expect(i18n._(failure.message)).toBe(
        'Nothing was changed — this device refused the account key the server offered. This can indicate tampering.',
      )
      expect(failure.action).toBe('phraseChange')
    })

    // The typed-error branch. It used to match on `err.message.includes('no
    // recovery slot')`, so rewording the thrown text silently dropped this
    // account into the transient bucket and offered a retry that cannot work.
    it('names a missing recovery slot, matched on the error type', () => {
      const failure = describeRevokeFailure(new MissingRecoverySlotError())
      expect(i18n._(failure.message)).toBe(
        'Nothing was changed — this account has no recovery phrase on record. This can indicate tampering.',
      )
      expect(failure.action).toBe('phraseChange')
    })

    it('does not match a plain Error that merely mentions a recovery slot', () => {
      const failure = describeRevokeFailure(new Error('Account has no recovery slot'))
      expect(failure.action).toBe('retry')
    })

    it('reaches the cause through a post-cut wrapper', () => {
      const failure = describeRevokeFailure(new LockoutIncompleteError({ cause: new MissingRecoverySlotError() }))
      expect(i18n._(failure.message)).toContain('this account has no recovery phrase on record')
      expect(failure.action).toBe('phraseChange')
    })
  })

  it('offers an explicit key refresh rather than retrying with stale material (THU-872)', () => {
    const failure = describeRevokeFailure(new StaleKeyMaterialError())
    expect(i18n._(failure.message)).toBe("Nothing was changed — this device's encryption keys are out of date.")
    expect(failure.action).toBe('refreshKeys')
  })
})
