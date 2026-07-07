/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Compute a simple 32-bit hash from an array of values. Used to fingerprint
 * default definitions so reconciliation can detect user edits by comparing
 * the stored `defaultHash` against a fresh recomputation.
 *
 * This function is load-bearing across the frontend/backend/shared boundary:
 * the exact same output is expected on every side, because stored hashes in
 * user databases depend on it byte-for-byte. Any change here silently
 * invalidates every existing `defaultHash` in the wild — treat as a wire
 * contract, not an implementation detail.
 */
export const hashValues = (values: (string | number | null | undefined)[]): string => {
  const str = values.join('|')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return hash.toString(36)
}
