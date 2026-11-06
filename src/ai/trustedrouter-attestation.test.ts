/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { AttestationVerificationError, GCP_ISSUER, GCP_JWKS_URI } from '@lore-hex/trusted-router/attestation'
import { classifyErrorKind } from '@/lib/error-utils'
import { getClock } from '@/testing-library'
import type { FetchFn } from '@/lib/proxy-fetch'
import {
  createTrustedRouterAttestation,
  trustedRouterAttestationUrl,
  verifyTrustedRouterGateway,
  type VerifiedTrustedRouterGateway,
} from './trustedrouter-attestation'

const trustReleaseUrl = 'https://trust.trustedrouter.com/trust/gcp-release.json'
const publishedDigest = `sha256:${'a'.repeat(64)}`
const publishedReference = 'us-central1-docker.pkg.dev/quill-cloud-proxy/quill/enclave-multi:gcp-release-test'
const certSha256 = 'c'.repeat(64)
const keyId = 'test-signer'

const rsaParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const

const googleKeys = await crypto.subtle.generateKey(rsaParams, true, ['sign', 'verify'])
const otherKeys = await crypto.subtle.generateKey(rsaParams, true, ['sign', 'verify'])
const googleJwk = await crypto.subtle.exportKey('jwk', googleKeys.publicKey)

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const encodeJson = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)))

type TokenOverrides = {
  imageDigest?: string
  exp?: number
  echoNonce?: boolean
  signingKey?: CryptoKey
}

/** Mint a Confidential Space-shaped RS256 token for the given nonce. */
const mintToken = async (nonceHex: string, overrides: TokenOverrides = {}): Promise<string> => {
  const claims = {
    iss: GCP_ISSUER,
    aud: 'quill-cloud',
    exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 3600,
    dbgstat: 'disabled-since-boot',
    swname: 'CONFIDENTIAL_SPACE',
    secboot: true,
    hwmodel: 'GCP_INTEL_TDX',
    eat_nonce: overrides.echoNonce === false ? [certSha256] : [certSha256, nonceHex],
    submods: {
      container: { image_digest: overrides.imageDigest ?? publishedDigest, image_reference: publishedReference },
    },
  }
  const signingInput = `${encodeJson({ alg: 'RS256', kid: keyId, typ: 'JWT' })}.${encodeJson(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    overrides.signingKey ?? googleKeys.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

/** Gateway stand-in: serves a token echoing the request's nonce. */
const createAttestationFetch = (overrides: TokenOverrides = {}) => {
  const requests: string[] = []
  const fetchFn: FetchFn = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requests.push(url.origin + url.pathname)
      return new Response(await mintToken(url.searchParams.get('nonce') ?? '', overrides))
    },
    { preconnect: async () => false },
  )
  return { fetchFn, requests }
}

/** Trust-anchor stand-in: the published trust release and Google's JWKS. */
const trustAnchorFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url === trustReleaseUrl) {
    return Response.json({ image_digest: publishedDigest, image_reference: publishedReference })
  }
  if (url === GCP_JWKS_URI) {
    return Response.json({ keys: [{ ...googleJwk, kid: keyId, alg: 'RS256' }] })
  }
  return new Response('unexpected', { status: 404 })
}) as typeof globalThis.fetch

describe('verifyTrustedRouterGateway', () => {
  it('accepts a signed token for the published image that echoes the nonce', async () => {
    const { fetchFn, requests } = createAttestationFetch()
    const verified = await verifyTrustedRouterGateway(fetchFn, trustAnchorFetch)
    expect(verified.imageDigest).toBe(publishedDigest)
    expect(verified.expiresAtMs).toBeGreaterThan(Date.now())
    expect(requests).toEqual([trustedRouterAttestationUrl])
  })

  it.each<[string, TokenOverrides]>([
    ['an image digest the trust release does not pin', { imageDigest: `sha256:${'b'.repeat(64)}` }],
    ['a signature from a key Google did not publish', { signingKey: otherKeys.privateKey }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['a token that does not echo the fresh nonce', { echoNonce: false }],
  ])('rejects %s', async (_label, overrides) => {
    const { fetchFn } = createAttestationFetch(overrides)
    await expect(verifyTrustedRouterGateway(fetchFn, trustAnchorFetch)).rejects.toBeInstanceOf(
      AttestationVerificationError,
    )
  })

  it('rejects when the attestation endpoint errors', async () => {
    const fetchFn: FetchFn = Object.assign(async () => new Response('down', { status: 503 }), {
      preconnect: async () => false,
    })
    await expect(verifyTrustedRouterGateway(fetchFn, trustAnchorFetch)).rejects.toThrow('HTTP 503')
  })
})

/** Upstream stand-in that records which requests reached it and answers
 *  attestation requests like the gateway would. */
const createUpstream = () => {
  const sent: string[] = []
  const fetchFn: FetchFn = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      sent.push(url.origin + url.pathname)
      if (url.origin + url.pathname === trustedRouterAttestationUrl) {
        return new Response(await mintToken(url.searchParams.get('nonce') ?? ''))
      }
      return new Response('ok')
    },
    { preconnect: async () => true },
  )
  return { fetchFn, sent }
}

const chatUrl = 'https://api.trustedrouter.com/v1/chat/completions'

describe('createTrustedRouterAttestation', () => {
  it('sends requests only after a successful verification and reports it', async () => {
    const trackAttestation = mock()
    const { withAttestation } = createTrustedRouterAttestation({
      verifyGateway: (attestationFetch) => verifyTrustedRouterGateway(attestationFetch, trustAnchorFetch),
      trackAttestation,
    })
    const upstream = createUpstream()
    const attestedFetch = withAttestation(upstream.fetchFn)

    const response = await attestedFetch(chatUrl, { method: 'POST' })

    expect(await response.text()).toBe('ok')
    // The token is fetched through the provider's own fetch, then the request is sent.
    expect(upstream.sent).toEqual([trustedRouterAttestationUrl, chatUrl])
    expect(trackAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', image_digest: publishedDigest }),
    )
    expect(await attestedFetch.preconnect()).toBe(true)
  })

  it.each<[string, TokenOverrides]>([
    ['wrong image digest', { imageDigest: `sha256:${'b'.repeat(64)}` }],
    ['bad signature', { signingKey: otherKeys.privateKey }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])('blocks the request on %s', async (_label, overrides) => {
    const trackAttestation = mock()
    const gateway = createAttestationFetch(overrides)
    const { withAttestation } = createTrustedRouterAttestation({
      verifyGateway: () => verifyTrustedRouterGateway(gateway.fetchFn, trustAnchorFetch),
      trackAttestation,
    })
    const upstream = createUpstream()

    const failure = await withAttestation(upstream.fetchFn)(chatUrl).catch((error: unknown) => error)

    expect(upstream.sent).toEqual([])
    expect(failure).toMatchObject({ name: 'TrustedRouterAttestationError' })
    expect(classifyErrorKind(failure)).toBe('attestation')
    expect(trackAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', error_name: 'AttestationVerificationError' }),
    )
  })

  it('blocks the request when verification times out', async () => {
    const trackAttestation = mock()
    const { withAttestation } = createTrustedRouterAttestation({
      verifyGateway: () => new Promise<VerifiedTrustedRouterGateway>(() => {}),
      timeoutMs: 1_000,
      trackAttestation,
    })
    const upstream = createUpstream()

    const pending = withAttestation(upstream.fetchFn)(chatUrl).catch((error: unknown) => error)
    await getClock().tickAsync(1_000)
    const failure = await pending

    expect(upstream.sent).toEqual([])
    expect(failure).toMatchObject({ name: 'TrustedRouterAttestationTimeoutError' })
    expect(classifyErrorKind(failure)).toBe('timeout')
    expect(trackAttestation).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'timeout' }))
  })

  it('shares one verification across concurrent requests and reuses it until it ages out', async () => {
    let nowMs = 1_000_000
    const verifyGateway = mock(async () => ({ imageDigest: publishedDigest, expiresAtMs: nowMs + 3_600_000 }))
    const { ensureVerified } = createTrustedRouterAttestation({
      verifyGateway,
      now: () => nowMs,
      maxAgeMs: 60_000,
      trackAttestation: () => {},
    })
    const { fetchFn } = createUpstream()

    await Promise.all([ensureVerified(fetchFn), ensureVerified(fetchFn)])
    expect(verifyGateway).toHaveBeenCalledTimes(1)

    nowMs += 59_000
    await ensureVerified(fetchFn)
    expect(verifyGateway).toHaveBeenCalledTimes(1)

    nowMs += 2_000
    await ensureVerified(fetchFn)
    expect(verifyGateway).toHaveBeenCalledTimes(2)
  })

  it('re-attests once the verified token expires, even within the max age', async () => {
    let nowMs = 1_000_000
    const verifyGateway = mock(async () => ({ imageDigest: publishedDigest, expiresAtMs: nowMs + 10_000 }))
    const { ensureVerified } = createTrustedRouterAttestation({
      verifyGateway,
      now: () => nowMs,
      maxAgeMs: 60_000,
      trackAttestation: () => {},
    })
    const { fetchFn } = createUpstream()

    await ensureVerified(fetchFn)
    nowMs += 10_000
    await ensureVerified(fetchFn)
    expect(verifyGateway).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed verification', async () => {
    const verifyGateway = mock<() => Promise<VerifiedTrustedRouterGateway>>()
      .mockRejectedValueOnce(new AttestationVerificationError('bad'))
      .mockResolvedValueOnce({ imageDigest: publishedDigest, expiresAtMs: Date.now() + 3_600_000 })
    const { ensureVerified } = createTrustedRouterAttestation({ verifyGateway, trackAttestation: () => {} })
    const { fetchFn } = createUpstream()

    await expect(ensureVerified(fetchFn)).rejects.toMatchObject({ name: 'TrustedRouterAttestationError' })
    await expect(ensureVerified(fetchFn)).resolves.toMatchObject({ imageDigest: publishedDigest })
    expect(verifyGateway).toHaveBeenCalledTimes(2)
  })
})
