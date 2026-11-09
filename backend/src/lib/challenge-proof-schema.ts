/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { challengeOperations } from '@shared/e2ee-types'
import { t } from 'elysia'

/** Elysia schema for the shared `ChallengeProof` request DTO; verify it with `verifyChallengeSignature`. */
export const proofSchema = t.Object({
  signature: t.String({ maxLength: 200 }),
  nonce: t.String({ maxLength: 128 }),
  operation: t.Union(challengeOperations.map((op) => t.Literal(op))),
  deviceId: t.String({ maxLength: 36 }),
})
