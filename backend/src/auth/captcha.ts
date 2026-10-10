/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { redeemCaptchaChallenge } from '@/dal'
import type { QueryableDatabase } from '@/db/client'
import { createChallenge, verifySolution } from 'altcha-lib/v1'
import { z } from 'zod'

/** Request header carrying the client's captcha solution. */
export const captchaTokenHeader = 'x-captcha-token'

/**
 * Request details beyond the solution. `clientIp` is resolved once by the caller from the
 * trusted proxy setting, so verifiers never decide which header to trust (Turnstile's
 * `remoteip` needs it; ALTCHA ignores it). 'unknown' when no trusted header is present.
 */
export type CaptchaContext = {
  clientIp: string
}

/** Verifies a captcha solution submitted with a bot-sensitive request (e.g. anonymous sign-in). */
export type CaptchaVerifier = {
  verify: (payload: string | null, context: CaptchaContext) => Promise<boolean>
}

type AltchaSettings = Pick<Settings, 'captchaSecret' | 'captchaDifficulty' | 'captchaTtlSecs'>

// Pinned so a payload cannot pick a weaker hash (the library also accepts SHA-1).
const altchaAlgorithm = 'SHA-256'

// The widget's v1 payload, base64-encoded JSON. `took` is client-reported and unused.
const altchaPayloadSchema = z.object({
  algorithm: z.literal(altchaAlgorithm),
  challenge: z.string(),
  number: z.number().int().nonnegative(),
  salt: z.string(),
  signature: z.string(),
})

const noneVerifier: CaptchaVerifier = {
  verify: async () => true,
}

/** Decode the widget's base64 JSON payload; null when it is not a well-formed SHA-256 solution. */
const parseAltchaPayload = (payload: string) => {
  try {
    const parsed = altchaPayloadSchema.safeParse(JSON.parse(atob(payload)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The expiry signed into the challenge salt. Every challenge we issue carries one, so a
 * payload without it was not minted by `createAltchaChallenge` and is rejected.
 */
const altchaExpiry = (salt: string) => {
  const expires = Number.parseInt(new URLSearchParams(salt.split('?')[1]).get('expires') ?? '', 10)
  return Number.isNaN(expires) ? null : new Date(expires * 1000)
}

const createAltchaVerifier = (settings: AltchaSettings, database: QueryableDatabase): CaptchaVerifier => ({
  verify: async (payload) => {
    const solution = payload ? parseAltchaPayload(payload) : null
    const expiresAt = solution ? altchaExpiry(solution.salt) : null
    if (!solution || !expiresAt) {
      return false
    }
    // verifySolution checks the hash, the HMAC signature and the signed expiry.
    if (!(await verifySolution(solution, settings.captchaSecret))) {
      return false
    }
    return redeemCaptchaChallenge(database, solution.challenge, expiresAt)
  },
})

/** Mint an ALTCHA challenge in the JSON shape the widget fetches from its `challengeurl`. */
export const createAltchaChallenge = (settings: AltchaSettings) =>
  createChallenge({
    algorithm: altchaAlgorithm,
    hmacKey: settings.captchaSecret,
    maxnumber: settings.captchaDifficulty,
    expires: new Date(Date.now() + settings.captchaTtlSecs * 1000),
  })

/**
 * Build the verifier for the configured CAPTCHA_PROVIDER. 'none' always passes, leaving
 * the IP rate limits as the only bot control. 'altcha' checks a proof-of-work solution and
 * redeems its challenge in Postgres so each solve is accepted once across all instances.
 */
export const createCaptchaVerifier = (
  settings: Pick<Settings, 'captchaProvider'> & AltchaSettings,
  database: QueryableDatabase,
): CaptchaVerifier => {
  switch (settings.captchaProvider) {
    case 'none':
      return noneVerifier
    case 'altcha':
      return createAltchaVerifier(settings, database)
  }
}
