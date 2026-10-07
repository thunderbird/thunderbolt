/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The operator key-escrow public key this BUILD trusts (THU-804 / THU-866).
 *
 * This is the escrow trust root, and it is deliberately a property of the
 * shipped artifact rather than of any server response. A client that wrapped the
 * Account Key to a key the server handed it would escrow every account to any
 * server willing to lie (C11) — so there is no server-side escrow key to ask
 * for: `GET /encryption/org-key` and the backend's `ORG_ESCROW_PUBLIC_KEY`
 * setting were both deleted.
 *
 * Read per call with no module-level memo, so tests can set the env var.
 *
 * @returns the base64 raw uncompressed P-256 point the operator published, or
 *   `undefined` when this build escrows nothing.
 */
export const pinnedOrgEscrowPublicKey = (): string | undefined =>
  import.meta.env.VITE_ORG_ESCROW_PUBLIC_KEY?.trim() || undefined
