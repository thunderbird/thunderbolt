/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { redeemCaptchaChallenge } from '@/dal'
import type { QueryableDatabase } from '@/db/client'
import { createChallenge, extractParams, verifySolution } from 'altcha-lib/v1'
import { z } from 'zod'

/** Request header carrying the client's captcha solution. */
export const captchaTokenHeader = 'x-captcha-token'

/**
 * Request details beyond the solution. `clientIp` is resolved once by the caller from the
 * trusted proxy setting, so providers never decide which header to trust (Turnstile's
 * `remoteip` needs it; ALTCHA ignores it). 'unknown' when no trusted header is present.
 */
export type CaptchaContext = {
  clientIp: string
}

/**
 * One captcha provider, owning both halves: `verify` checks a solution submitted with a
 * bot-sensitive request (e.g. anonymous sign-in), and `issueChallenge`, present only for
 * providers that mint challenges, returns the JSON the client widget fetches.
 */
export type CaptchaProvider = {
  verify: (payload: string | null, context: CaptchaContext) => Promise<boolean>
  issueChallenge?: () => Promise<unknown>
}

type AltchaSettings = Pick<Settings, 'altchaSecret' | 'altchaDifficulty' | 'altchaTtlSecs'>

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

const noneProvider: CaptchaProvider = {
  verify: async () => true,
}

type AltchaPayload = z.infer<typeof altchaPayloadSchema>

/** Why an ALTCHA solution was refused; logged so a venue-wide 403 is diagnosable. */
type AltchaRejection = 'malformed' | 'no_expiry' | 'invalid' | 'replayed'

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
 * The expiry signed into the challenge salt, read with the library's own `extractParams` so
 * it is the value `verifySolution` checks. Every challenge we issue carries one, so a payload
 * without it was not minted by `createAltchaChallenge` and is rejected.
 */
const parseAltchaExpiry = (solution: AltchaPayload) => {
  const params = extractParams(solution)
  const expires = Number.parseInt(params.expires || params.expire || '', 10)
  return Number.isNaN(expires) ? null : new Date(expires * 1000)
}

/** Check a solution without logging; resolves the rejection reason, or null when accepted. */
const checkAltchaSolution = async (
  settings: AltchaSettings,
  database: QueryableDatabase,
  payload: string | null,
): Promise<AltchaRejection | null> => {
  const solution = payload ? parseAltchaPayload(payload) : null
  if (!solution) {
    return 'malformed'
  }
  const expiresAt = parseAltchaExpiry(solution)
  if (!expiresAt) {
    return 'no_expiry'
  }
  // verifySolution checks the hash, the HMAC signature and the signed expiry. It runs before
  // the redeem so a rejected payload never burns its challenge.
  if (!(await verifySolution(solution, settings.altchaSecret))) {
    return 'invalid'
  }
  return (await redeemCaptchaChallenge(database, solution.challenge, expiresAt)) ? null : 'replayed'
}

/** Mint an ALTCHA challenge in the JSON shape the widget fetches from its `challengeurl`. */
const createAltchaChallenge = (settings: AltchaSettings) =>
  createChallenge({
    algorithm: altchaAlgorithm,
    hmacKey: settings.altchaSecret,
    maxnumber: settings.altchaDifficulty,
    expires: new Date(Date.now() + settings.altchaTtlSecs * 1000),
  })

const createAltchaProvider = (settings: AltchaSettings, database: QueryableDatabase): CaptchaProvider => ({
  verify: async (payload) => {
    const rejection = await checkAltchaSolution(settings, database, payload)
    if (rejection) {
      // The reason only, never the payload.
      console.warn('Captcha verification failed:', rejection)
      return false
    }
    return true
  },
  issueChallenge: () => createAltchaChallenge(settings),
})

/**
 * Build the provider for the configured CAPTCHA_PROVIDER; the only place a provider is
 * selected. 'none' always passes and issues no challenges, leaving the rate limits as the
 * only bot control. 'altcha' issues proof-of-work challenges, checks solutions and redeems
 * each challenge in Postgres so a solve is accepted once across all instances.
 */
export const createCaptchaProvider = (
  settings: Pick<Settings, 'captchaProvider'> & AltchaSettings,
  database: QueryableDatabase,
): CaptchaProvider => {
  switch (settings.captchaProvider) {
    case 'none':
      return noneProvider
    case 'altcha':
      return createAltchaProvider(settings, database)
  }
}
