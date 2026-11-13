/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Give untyped vendor verification failures a stable contract while preserving their cause. */
export const asAttestationFailure = (cause: unknown): Error => {
  if (
    cause instanceof Error &&
    (cause.name === 'AbortError' ||
      cause.name.endsWith('AttestationTimeoutError') ||
      ('category' in cause && cause.category === 'attestation'))
  ) {
    return cause
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return Object.assign(new Error(`Confidential connection verification failed: ${message}`, { cause }), {
    name: 'AttestationError',
    category: 'attestation',
  })
}
