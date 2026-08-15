/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { SignJWT, jwtVerify } from 'jose'

/**
 * Per-deployment inference JWTs let a deployed sandbox agent call our managed
 * models (`/v1/chat/completions`) as the owning user. The token carries the
 * owner's id as `sub` and the deployment id as a private claim; the inference
 * route resolves it back to the owner and enforces revocation via the
 * `agent_deployments` table (the token itself is typically non-expiring, so
 * revocation is the only kill switch).
 */
const agentInferenceAud = 'agent-inference'
const alg = 'HS256'

/** Load the HMAC secret used to sign/verify agent inference tokens. */
const secretKey = (): Uint8Array => {
  const secret = getSettings().agentInferenceJwtSecret
  if (!secret) {
    throw new Error('agentInferenceJwtSecret is not configured')
  }
  return new TextEncoder().encode(secret)
}

/**
 * Mint a scoped inference token for a deployed agent. Pass `expiresInSeconds:
 * null` to mint a non-expiring token (the default for sandbox deployments —
 * revocation is handled out-of-band via the deployment record).
 */
export const mintAgentInferenceToken = async ({
  userId,
  deploymentId,
  expiresInSeconds,
}: {
  userId: string
  deploymentId: string
  expiresInSeconds: number | null
}): Promise<string> => {
  const jwt = new SignJWT({ deploymentId })
    .setProtectedHeader({ alg })
    .setSubject(userId)
    .setAudience(agentInferenceAud)
    .setIssuedAt()

  if (expiresInSeconds !== null) {
    jwt.setExpirationTime(`${expiresInSeconds}s`)
  }

  return jwt.sign(secretKey())
}

/**
 * Verify an agent inference token. Returns the owner + deployment claims on a
 * valid signature/audience, or `null` for any failure (bad signature, wrong
 * audience, expired, or missing claims).
 */
export const verifyAgentInferenceToken = async (
  token: string,
): Promise<{ userId: string; deploymentId: string } | null> => {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      audience: agentInferenceAud,
      algorithms: [alg],
    })

    const { sub, deploymentId } = payload
    if (typeof sub !== 'string' || typeof deploymentId !== 'string') {
      return null
    }

    return { userId: sub, deploymentId }
  } catch {
    return null
  }
}
