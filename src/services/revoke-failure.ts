/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
  AKAnchorError,
  LockoutIncompleteError,
  MissingRecoverySlotError,
  RecoveryAnchorError,
  StaleKeyMaterialError,
} from '@/services/encryption'

/**
 * How the user clears the failure. Rendered as an action beside the message
 * rather than named in prose: "change your recovery phrase" is three
 * navigations away (Settings → Preferences → Data), so a sentence that merely
 * says it is a dangling instruction.
 */
export type RevokeFailureAction = 'retry' | 'phraseChange' | 'finishLockout' | 'refreshKeys'

export type RevokeFailure = {
  /**
   * A descriptor, not a string. This is called during render from a component
   * that may outlive a language change, and `msg` at module scope is the only
   * form that follows one — the display boundary resolves it with `i18n._`.
   */
  message: MessageDescriptor
  action: RevokeFailureAction
}

/**
 * The two causes that are neither transient nor retryable: the served recovery
 * anchor did not verify (THU-865) or the served account key did not match this
 * device's witness (THU-869). Both mean "re-anchor the account", and both must
 * be named as possible tampering. An account with no recovery slot needs the
 * same re-anchor, so it belongs here too. Everything else is transient or
 * unknown, and is reported as such rather than dressed up.
 */
type WedgeCause = 'recoveryAnchor' | 'akAnchor' | 'noRecoverySlot'

const wedgeCause = (err: unknown): WedgeCause | null => {
  if (err instanceof RecoveryAnchorError) {
    return 'recoveryAnchor'
  }
  if (err instanceof AKAnchorError) {
    return 'akAnchor'
  }
  if (err instanceof MissingRecoverySlotError) {
    return 'noRecoverySlot'
  }
  return null
}

/**
 * Whole sentences, one per outcome, deliberately not assembled from a phase
 * clause plus a cause clause plus a tampering clause. The English reads as
 * though it were — but word order is not portable, and a translator handed
 * "this device refused the account key the server offered" as a fragment has no
 * way to know what it will be glued to.
 *
 * The cost is that the phase clause is repeated six times. That is the right
 * trade here: the phase clause is the security-relevant half of the sentence,
 * and it is exactly the half a concatenation would let a translation reorder
 * away from the cause it qualifies.
 */
const wedgeMessage: Record<'preCut' | 'postCut', Record<WedgeCause, MessageDescriptor>> = {
  preCut: {
    recoveryAnchor: msg`Nothing was changed — the recovery keys the server offered could not be verified against this device. This can indicate tampering.`,
    akAnchor: msg`Nothing was changed — this device refused the account key the server offered. This can indicate tampering.`,
    noRecoverySlot: msg`Nothing was changed — this account has no recovery phrase on record. This can indicate tampering.`,
  },
  postCut: {
    recoveryAnchor: msg`The device lost access, but your account key was not replaced, so it can still read your data — the recovery keys the server offered could not be verified against this device. This can indicate tampering.`,
    akAnchor: msg`The device lost access, but your account key was not replaced, so it can still read your data — this device refused the account key the server offered. This can indicate tampering.`,
    noRecoverySlot: msg`The device lost access, but your account key was not replaced, so it can still read your data — this account has no recovery phrase on record. This can indicate tampering.`,
  },
}

const preCutUnknownCause = msg`Nothing was changed. The device was not revoked.`
const postCutUnknownCause = msg`The device lost access, but your account key was not replaced, so it can still read your data.`
const staleKeyMaterial = msg`Nothing was changed — this device's encryption keys are out of date.`

/**
 * Plain-language outcome of a revocation that did not complete, for the revoke
 * dialog.
 *
 * THE POINT IS THE PHASE, not the prose. Revoking cuts server access and then
 * replaces the account key; THU-887 was a UI that could not tell those apart and
 * so reported neither. `LockoutIncompleteError` marks that the cut already
 * committed, which is what lets a message state an outcome instead of hedging
 * every one of them:
 *
 * - without it, nothing was applied, and the message says exactly that;
 * - with it, access is gone but the removed device still holds a usable key, so
 *   the outstanding work is the rotation — never a re-revoke, which is a no-op.
 *
 * A message never claims what it cannot know. The genuinely ambiguous case is
 * narrow: a rotation request that may or may not have committed before the
 * response was lost. This cannot tell, and does not guess — the server-derived
 * owed-lockout list (`fetchLockoutPending`) settles it after the fact, which is
 * also why the row keeps its own "Finish securing" action regardless of what
 * this returns.
 */
export const describeRevokeFailure = (err: unknown): RevokeFailure => {
  // Pre-cut and deliberate (THU-872): the canary opens only under the CURRENT
  // account key, and the revoke path never refreshes silently — an emergency
  // cut must not have a server-driven key adoption running invisibly inside it.
  // Nothing was applied; the fix is an explicit refresh, then retry.
  if (err instanceof StaleKeyMaterialError) {
    return { message: staleKeyMaterial, action: 'refreshKeys' }
  }

  if (err instanceof LockoutIncompleteError) {
    const cause = wedgeCause(err.cause)
    return cause
      ? { message: wedgeMessage.postCut[cause], action: 'phraseChange' }
      : { message: postCutUnknownCause, action: 'finishLockout' }
  }

  const cause = wedgeCause(err)
  return cause
    ? { message: wedgeMessage.preCut[cause], action: 'phraseChange' }
    : { message: preCutUnknownCause, action: 'retry' }
}
