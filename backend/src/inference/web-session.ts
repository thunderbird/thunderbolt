/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type RequestContext = Readonly<{ request: Request }>

/**
 * Reject personal access tokens on the confidential routes unless the operator
 * has opted in.
 *
 * This is an authorization choice, not a cryptographic one. The confidentiality
 * guarantee comes from the caller: the Tinfoil SDK attests the enclave and
 * HPKE-seals the body, and this proxy forwards ciphertext it cannot read
 * (`{ parse: 'none' }` in `src/tinfoil/routes.ts`). The `userCacheSecret` that
 * partitions the enclave's prompt cache is generated client-side and never
 * reaches us, so a PAT-authenticated caller can supply its own exactly as the
 * CLI and the browser already do.
 *
 * What a PAT does lack is the device binding a web session carries, and it
 * outlives one. Confidential inference is metered against the account through
 * signed usage receipts, so an operator enabling this is choosing to let a
 * long-lived headless credential spend on that tier. Hence: off by default.
 */
export const rejectPersonalAccessToken = (
  { request }: RequestContext,
  confidentialApiKeysEnabled: boolean,
): Response | undefined =>
  request.headers.has('x-api-key') && !confidentialApiKeysEnabled
    ? Response.json({ error: { code: 'WEB_LOGIN_REQUIRED' } }, { status: 403 })
    : undefined
