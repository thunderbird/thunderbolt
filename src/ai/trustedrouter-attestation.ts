/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TrustedRouter gateway attestation, checked in the app before requests are sent.
 *
 * TrustedRouter's gateway runs as a Google Confidential Space workload. Its
 * `/attestation` endpoint returns a Google-signed token describing the running
 * workload. Before the first TrustedRouter request, and again once a
 * verification is older than {@link trustedRouterAttestationMaxAgeMs} or its
 * token has expired, the app fetches that token with a fresh random nonce and
 * verifies it with `@lore-hex/trusted-router`:
 *
 * - RS256 signature against Google's Confidential Space signing keys (JWKS)
 * - issuer, audience, expiry, non-debug image, Secure Boot, and TEE hardware model
 * - the container image digest/reference is one pinned by TrustedRouter's
 *   published trust release
 * - the token echoes this verification's nonce, so a stale token can't be replayed
 *
 * Requests fail closed: if verification fails or times out, the request is not sent.
 *
 * Scope of the guarantee: this is document-level verification. It is NOT bound to
 * the TLS connection that carries chat requests. The token commits to the
 * gateway's TLS certificate hash, but a browser cannot read the peer certificate,
 * and in the web app requests reach TrustedRouter through Thunderbolt's universal
 * proxy. It proves that the published gateway build is what
 * api.trustedrouter.com is serving right now. It does not prove that a given
 * request reached that gateway, and it says nothing about the model providers
 * TrustedRouter routes to.
 *
 * The attestation token itself is fetched through the provider's fetch (the
 * endpoint has no CORS headers). The trust anchors, Google's JWKS and the trust
 * release, are fetched directly (both serve CORS), so a relay that forwards the
 * token cannot also substitute the keys or image pins it is checked against.
 */

import { getErrorName } from '@/lib/error-utils'
import type { FetchFn } from '@/lib/proxy-fetch'
import { trackEvent } from '@/lib/posthog'
import { withDeadline } from '@/lib/timeout'

export const trustedRouterAttestationUrl = 'https://api.trustedrouter.com/attestation'
export const trustedRouterAttestationTimeoutMs = 15_000
/** How long a successful verification is reused before the next request re-attests. */
export const trustedRouterAttestationMaxAgeMs = 10 * 60_000

/** Claims read from a token that has already passed verification. */
export type VerifiedTrustedRouterGateway = {
  imageDigest: string
  /** Token expiry, in milliseconds since the epoch. */
  expiresAtMs: number
}

type TrustedRouterAttestationProperties = {
  outcome: 'success' | 'error' | 'timeout'
  duration_ms: number
  error_name?: string
  image_digest?: string
}

type TrustedRouterAttestationOptions = {
  /** Fetch and verify one attestation token; rejects when any check fails. */
  verifyGateway: (attestationFetch: FetchFn) => Promise<VerifiedTrustedRouterGateway>
  now?: () => number
  timeoutMs?: number
  maxAgeMs?: number
  trackAttestation?: (properties: TrustedRouterAttestationProperties) => void
}

/** A verification in flight or completed; reusable while `validUntilMs` is ahead. */
type CacheEntry = { promise: Promise<VerifiedTrustedRouterGateway>; validUntilMs: number }

/** Create the timeout error surfaced when attestation does not settle. */
const createAttestationTimeoutError = (timeoutMs: number): Error =>
  Object.assign(new Error(`TrustedRouter attestation timed out after ${timeoutMs}ms`), {
    name: 'TrustedRouterAttestationTimeoutError',
  })

/** Wrap a verification failure under a stable name for error classification. */
const createAttestationError = (cause: unknown): Error => {
  const causeName = getErrorName(cause) ?? 'Error'
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  return Object.assign(new Error(`TrustedRouter attestation failed: ${causeName}: ${causeMessage}`, { cause }), {
    name: 'TrustedRouterAttestationError',
  })
}

/** 32 random bytes as lowercase hex, the nonce format the gateway echoes. */
const createNonceHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Decode the claims of a JWT whose signature has already been verified. */
const readVerifiedClaims = (document: Uint8Array): VerifiedTrustedRouterGateway => {
  const payload = new TextDecoder().decode(document).trim().split('.')[1] ?? ''
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as {
    exp: number
    submods: { container: { image_digest: string } }
  }
  return { imageDigest: claims.submods.container.image_digest, expiresAtMs: claims.exp * 1000 }
}

/**
 * Fetch the gateway's attestation token with a fresh nonce and verify it
 * against the published trust release.
 *
 * Uses `verifyReceiptKeyAttestation` because it runs every signature, claim,
 * and image-pin check of `verifyGatewayAttestation` while leaving out the live
 * TLS binding, which needs the peer certificate a browser cannot read. The
 * nonce is passed as the commitment that must appear in the token's
 * `eat_nonce`, giving the same freshness check.
 */
export const verifyTrustedRouterGateway = async (
  attestationFetch: FetchFn,
  trustAnchorFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<VerifiedTrustedRouterGateway> => {
  // Dynamically imported, like `tinfoil`, to keep the verifier out of the entry bundle.
  const { policyFromTrustRelease, verifyReceiptKeyAttestation } = await import('@lore-hex/trusted-router/attestation')
  const nonceHex = createNonceHex()
  const [policy, document] = await Promise.all([
    policyFromTrustRelease({ fetchImpl: trustAnchorFetch }),
    (async () => {
      const response = await attestationFetch(`${trustedRouterAttestationUrl}?nonce=${nonceHex}`)
      if (!response.ok) {
        throw new Error(`Attestation endpoint returned HTTP ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    })(),
  ])
  await verifyReceiptKeyAttestation(document, { policy, keyCommitmentHex: nonceHex, fetchImpl: trustAnchorFetch })
  return readVerifiedClaims(document)
}

/**
 * Create an isolated attestation lifecycle. Production uses one instance;
 * tests inject the verifier, clock, timeout, and telemetry.
 */
export const createTrustedRouterAttestation = ({
  verifyGateway,
  now = Date.now,
  timeoutMs = trustedRouterAttestationTimeoutMs,
  maxAgeMs = trustedRouterAttestationMaxAgeMs,
  trackAttestation = (properties) => trackEvent('trustedrouter_attestation', properties),
}: TrustedRouterAttestationOptions) => {
  let cached: CacheEntry | null = null

  /** Verify once, timing and reporting the outcome; failures are wrapped. */
  const attest = async (attestationFetch: FetchFn): Promise<VerifiedTrustedRouterGateway> => {
    const startedAt = now()
    try {
      const verified = await withDeadline(verifyGateway(attestationFetch), timeoutMs, () =>
        createAttestationTimeoutError(timeoutMs),
      )
      trackAttestation({ outcome: 'success', duration_ms: now() - startedAt, image_digest: verified.imageDigest })
      return verified
    } catch (error) {
      const isTimeout = getErrorName(error) === 'TrustedRouterAttestationTimeoutError'
      trackAttestation({
        outcome: isTimeout ? 'timeout' : 'error',
        duration_ms: now() - startedAt,
        error_name: getErrorName(error),
      })
      throw isTimeout ? error : createAttestationError(error)
    }
  }

  /** Once a verification settles, bound its reuse or evict it on failure. The
   *  caller observes the rejection through `entry.promise`. */
  const settle = async (entry: CacheEntry): Promise<void> => {
    try {
      const verified = await entry.promise
      entry.validUntilMs = Math.min(now() + maxAgeMs, verified.expiresAtMs)
    } catch {
      if (cached === entry) {
        cached = null
      }
    }
  }

  /** Return the current verification, or start a new one. Concurrent callers
   *  share one verification; a failure is evicted so the next call retries. */
  const ensureVerified = (attestationFetch: FetchFn): Promise<VerifiedTrustedRouterGateway> => {
    if (cached && now() < cached.validUntilMs) {
      return cached.promise
    }
    const entry: CacheEntry = { promise: attest(attestationFetch), validUntilMs: Number.POSITIVE_INFINITY }
    cached = entry
    void settle(entry)
    return entry.promise
  }

  /** Wrap a fetch so every request waits for a current, successful verification. */
  const withAttestation = (inner: FetchFn): FetchFn =>
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        await ensureVerified(inner)
        return inner(input, init)
      },
      { preconnect: inner.preconnect },
    )

  return { ensureVerified, withAttestation }
}

export const { ensureVerified: ensureTrustedRouterVerified, withAttestation: withTrustedRouterAttestation } =
  createTrustedRouterAttestation({
    verifyGateway: (attestationFetch) => verifyTrustedRouterGateway(attestationFetch),
  })
