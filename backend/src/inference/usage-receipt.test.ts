/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHmac } from 'node:crypto'
import { describe, expect, it, spyOn } from 'bun:test'
import {
  issueInferenceUsageReceipt,
  verifyInferenceUsageReceipt,
  type InferenceUsageReceiptClaims,
} from './usage-receipt'

const secret = 'receipt-test-secret'
const nowSeconds = 1_787_616_000
const eventId = 'e8c39457-8831-4c10-86ae-8623b6ce2750'
const keyDomain = 'thunderbolt/inference-usage-receipt/key/v1'

type TestReceiptPayload = {
  purpose?: string
  version?: number
  eventId?: string
  userId?: string | number
  provider?: string
  model?: string
  inputNanoUsdPerToken?: string | number
  outputNanoUsdPerToken?: string | number
  issuedAt?: number
  expiresAt?: number
  unexpected?: boolean
}

const validClaims: InferenceUsageReceiptClaims = {
  purpose: 'inference-usage-receipt',
  version: 1,
  eventId,
  userId: 'receipt-user',
  provider: 'tinfoil',
  model: 'glm-5-2',
  inputNanoUsdPerToken: '1500',
  outputNanoUsdPerToken: '5250',
  issuedAt: nowSeconds,
  expiresAt: nowSeconds + 7_200,
}

const signPayload = (
  payload: TestReceiptPayload,
  options: Readonly<{ rootSecret?: string; domain?: string; deriveKey?: boolean }> = {},
): string => {
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const rootSecret = options.rootSecret ?? secret
  const key =
    options.deriveKey === false
      ? rootSecret
      : createHmac('sha256', rootSecret)
          .update(options.domain ?? keyDomain, 'utf8')
          .digest()
  const signature = createHmac('sha256', key).update(`iu1.${payloadSegment}`, 'ascii').digest('base64url')
  return `iu1.${payloadSegment}.${signature}`
}

const issueValidReceipt = () =>
  issueInferenceUsageReceipt({
    eventId,
    userId: validClaims.userId,
    price: {
      provider: 'tinfoil',
      model: 'glm-5-2',
      inputNanoUsdPerToken: 1_500n,
      outputNanoUsdPerToken: 5_250n,
    },
    secret,
    nowSeconds,
  })

describe('inference usage receipts', () => {
  it('issues an unpadded three-segment base64url token and verifies its strict claims', () => {
    const token = issueValidReceipt()

    expect(token).toMatch(/^iu1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(token).not.toContain('=')
    expect(token.split('.')).toHaveLength(3)
    expect(verifyInferenceUsageReceipt(token, secret, nowSeconds)).toEqual(validClaims)
  })

  it.each([
    ['two segments', 'iu1.payload'],
    ['four segments', 'iu1.payload.signature.extra'],
    ['wrong prefix', 'iu2.payload.signature'],
    ['empty payload', 'iu1..signature'],
    ['empty signature', 'iu1.payload.'],
    ['padded payload', 'iu1.eyJmb28iOiJiYXIifQ==.signature'],
    ['invalid payload character', 'iu1.pay+load.signature'],
    ['invalid signature character', 'iu1.payload.sign/ature'],
    ['undecodable segments', 'iu1.A.A'],
  ])('rejects malformed token segments: %s', (_name, token) => {
    expect(verifyInferenceUsageReceipt(token, secret, nowSeconds)).toBeNull()
  })

  it('rejects altered raw payload and signature segments', () => {
    const token = issueValidReceipt()
    const [prefix, payload, signature] = token.split('.') as [string, string, string]
    const alteredPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`
    const alteredSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`

    expect(verifyInferenceUsageReceipt(`${prefix}.${alteredPayload}.${signature}`, secret, nowSeconds)).toBeNull()
    expect(verifyInferenceUsageReceipt(`${prefix}.${payload}.${alteredSignature}`, secret, nowSeconds)).toBeNull()
  })

  it('rejects another secret, another key domain, and a raw Better Auth HMAC key', () => {
    expect(verifyInferenceUsageReceipt(issueValidReceipt(), 'another-secret', nowSeconds)).toBeNull()
    expect(
      verifyInferenceUsageReceipt(signPayload(validClaims, { domain: `${keyDomain}/wrong` }), secret, nowSeconds),
    ).toBeNull()
    expect(verifyInferenceUsageReceipt(signPayload(validClaims, { deriveKey: false }), secret, nowSeconds)).toBeNull()
  })

  it('verifies the signature before attempting to parse an untrusted payload', () => {
    const invalidJson = Buffer.from('{', 'utf8').toString('base64url')
    const invalidSignature = Buffer.alloc(32).toString('base64url')
    const parse = spyOn(JSON, 'parse')

    try {
      expect(verifyInferenceUsageReceipt(`iu1.${invalidJson}.${invalidSignature}`, secret, nowSeconds)).toBeNull()
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('returns the same public result for signed malformed JSON without exposing parse details', () => {
    const payloadSegment = Buffer.from('{', 'utf8').toString('base64url')
    const key = createHmac('sha256', secret).update(keyDomain, 'utf8').digest()
    const signature = createHmac('sha256', key).update(`iu1.${payloadSegment}`, 'ascii').digest('base64url')

    expect(verifyInferenceUsageReceipt(`iu1.${payloadSegment}.${signature}`, secret, nowSeconds)).toBeNull()
  })

  it.each([
    ['missing purpose', { purpose: undefined }],
    ['wrong purpose', { purpose: 'another-purpose' }],
    ['missing version', { version: undefined }],
    ['wrong version', { version: 2 }],
    ['missing event ID', { eventId: undefined }],
    ['non-v4 event ID', { eventId: 'e8c39457-8831-3c10-86ae-8623b6ce2750' }],
    ['uppercase event ID', { eventId: eventId.toUpperCase() }],
    ['missing user ID', { userId: undefined }],
    ['empty user ID', { userId: '' }],
    ['non-string user ID', { userId: 123 }],
    ['missing provider', { provider: undefined }],
    ['wrong provider', { provider: 'anthropic' }],
    ['missing model', { model: undefined }],
    ['wrong model', { model: 'opus-5' }],
    ['extra claim', { unexpected: true }],
  ])('rejects non-strict claims: %s', (_name, changes) => {
    const claims = { ...validClaims, ...changes }

    expect(verifyInferenceUsageReceipt(signPayload(claims), secret, nowSeconds)).toBeNull()
  })

  it.each([
    ['missing input rate', { inputNanoUsdPerToken: undefined }],
    ['negative input rate', { inputNanoUsdPerToken: '-1' }],
    ['padded input rate', { inputNanoUsdPerToken: '01500' }],
    ['decimal input rate', { inputNanoUsdPerToken: '1.5' }],
    ['empty input rate', { inputNanoUsdPerToken: '' }],
    ['non-string input rate', { inputNanoUsdPerToken: 1500 }],
    ['missing output rate', { outputNanoUsdPerToken: undefined }],
    ['signed output rate', { outputNanoUsdPerToken: '+5250' }],
    ['padded zero output rate', { outputNanoUsdPerToken: '00' }],
  ])('rejects a noncanonical decimal rate: %s', (_name, changes) => {
    expect(verifyInferenceUsageReceipt(signPayload({ ...validClaims, ...changes }), secret, nowSeconds)).toBeNull()
  })

  it('accepts canonical zero decimal rates', () => {
    const claims = { ...validClaims, inputNanoUsdPerToken: '0', outputNanoUsdPerToken: '0' }

    expect(verifyInferenceUsageReceipt(signPayload(claims), secret, nowSeconds)).toEqual(claims)
  })

  it.each([
    ['fractional issued time', { issuedAt: nowSeconds + 0.5, expiresAt: nowSeconds + 7_200.5 }],
    ['negative issued time', { issuedAt: -1, expiresAt: 7_199 }],
    ['unsafe issued time', { issuedAt: Number.MAX_SAFE_INTEGER + 1, expiresAt: Number.MAX_SAFE_INTEGER + 7_201 }],
    ['fractional expiry', { expiresAt: nowSeconds + 7_200.5 }],
    ['short lifetime', { expiresAt: nowSeconds + 7_199 }],
    ['long lifetime', { expiresAt: nowSeconds + 7_201 }],
  ])('rejects invalid receipt times: %s', (_name, changes) => {
    expect(verifyInferenceUsageReceipt(signPayload({ ...validClaims, ...changes }), secret, nowSeconds)).toBeNull()
  })

  it('uses an exclusive expiration boundary', () => {
    const token = signPayload(validClaims)

    expect(verifyInferenceUsageReceipt(token, secret, validClaims.expiresAt - 1)).toEqual(validClaims)
    expect(verifyInferenceUsageReceipt(token, secret, validClaims.expiresAt)).toBeNull()
  })

  it('allows exactly 60 seconds of future skew and rejects 61 seconds', () => {
    const atBoundary = {
      ...validClaims,
      issuedAt: nowSeconds + 60,
      expiresAt: nowSeconds + 60 + 7_200,
    }
    const beyondBoundary = {
      ...validClaims,
      issuedAt: nowSeconds + 61,
      expiresAt: nowSeconds + 61 + 7_200,
    }

    expect(verifyInferenceUsageReceipt(signPayload(atBoundary), secret, nowSeconds)).toEqual(atBoundary)
    expect(verifyInferenceUsageReceipt(signPayload(beyondBoundary), secret, nowSeconds)).toBeNull()
  })

  it('accepts a valid payload with a different JSON key order', () => {
    const reordered = {
      expiresAt: validClaims.expiresAt,
      issuedAt: validClaims.issuedAt,
      outputNanoUsdPerToken: validClaims.outputNanoUsdPerToken,
      inputNanoUsdPerToken: validClaims.inputNanoUsdPerToken,
      model: validClaims.model,
      provider: validClaims.provider,
      userId: validClaims.userId,
      eventId: validClaims.eventId,
      version: validClaims.version,
      purpose: validClaims.purpose,
    }

    expect(verifyInferenceUsageReceipt(signPayload(reordered), secret, nowSeconds)).toEqual(validClaims)
  })
})
