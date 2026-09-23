/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AKAnchorError,
  LockoutIncompleteError,
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
  message: string
  /** Present only when a specific cause was recognised; drives the wording too. */
  action: RevokeFailureAction
}

/**
 * The two causes that are neither transient nor retryable: the served recovery
 * anchor did not verify (THU-865) or the served account key did not match this
 * device's witness (THU-869). Both mean "re-anchor the account", and both must
 * be named as possible tampering. Everything else is transient or unknown, and
 * is reported as such rather than dressed up.
 */
const wedgeCause = (err: unknown): string | null => {
  if (err instanceof RecoveryAnchorError) {
    return 'the recovery keys the server offered could not be verified against this device'
  }
  if (err instanceof AKAnchorError) {
    return 'this device refused the account key the server offered'
  }
  // An account with no recovery slot throws a plain Error, and it needs the same
  // re-anchor, so it belongs here rather than in the transient bucket.
  if (err instanceof Error && err.message.includes('no recovery slot')) {
    return 'this account has no recovery phrase on record'
  }
  return null
}

const tamperingNote = ' This can indicate tampering.'

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
    return {
      message: "Nothing was changed — this device's encryption keys are out of date.",
      action: 'refreshKeys',
    }
  }

  const cause = wedgeCause(err instanceof LockoutIncompleteError ? err.cause : err)

  if (err instanceof LockoutIncompleteError) {
    return {
      message: cause
        ? `The device lost access, but your account key was not replaced, so it can still read your ` +
          `data — ${cause}.${tamperingNote}`
        : 'The device lost access, but your account key was not replaced, so it can still read your data.',
      action: cause ? 'phraseChange' : 'finishLockout',
    }
  }

  return {
    message: cause
      ? `Nothing was changed — ${cause}.${tamperingNote}`
      : 'Nothing was changed. The device was not revoked.',
    action: cause ? 'phraseChange' : 'retry',
  }
}
