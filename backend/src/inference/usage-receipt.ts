/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveConfidentialManagedModel } from './managed-models'
import { z } from 'zod'
import type { InferencePrice } from './usage-ledger'

export type IssueReceiptInput = Readonly<{
  eventId: string
  userId: string
  price: InferencePrice
  secret: string
  nowSeconds: number
}>

const receiptKeyDomain = 'thunderbolt/inference-usage-receipt/key/v1'
const receiptLifetimeSeconds = 7_200
const receiptFutureSkewSeconds = 60
const base64UrlPattern = /^[A-Za-z0-9_-]+$/
const canonicalUuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const canonicalUnsignedDecimalPattern = /^(?:0|[1-9][0-9]*)$/
const receiptClaimsSchema = z
  .strictObject({
    purpose: z.literal('inference-usage-receipt'),
    version: z.literal(1),
    eventId: z.string().regex(canonicalUuidV4Pattern),
    userId: z.string().min(1),
    provider: z.literal('tinfoil'),
    model: z.string().refine((model) => resolveConfidentialManagedModel(model) !== undefined),
    inputNanoUsdPerToken: z.string().regex(canonicalUnsignedDecimalPattern),
    outputNanoUsdPerToken: z.string().regex(canonicalUnsignedDecimalPattern),
    issuedAt: z.number().int().safe().nonnegative(),
    expiresAt: z.number().int().safe().nonnegative(),
  })
  .refine((claims) => claims.expiresAt === claims.issuedAt + receiptLifetimeSeconds)

export type InferenceUsageReceiptClaims = Readonly<z.infer<typeof receiptClaimsSchema>>

/** Derive the receipt-only key and sign an exact serialized token prefix. */
const signReceiptInput = (signingInput: string, secret: string): Buffer => {
  const receiptKey = createHmac('sha256', secret).update(receiptKeyDomain, 'utf8').digest()
  return createHmac('sha256', receiptKey).update(signingInput, 'ascii').digest()
}

/** Serialize receipt claims once as unpadded base64url UTF-8 JSON. */
const encodeReceiptPayload = (claims: InferenceUsageReceiptClaims): string =>
  Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')

/** Check the unpadded base64url grammar before decoding a token segment. */
const isBase64UrlSegment = (segment: string): boolean => base64UrlPattern.test(segment) && segment.length % 4 !== 1

/** Issue a signed receipt for one confidential managed inference event. */
export const issueInferenceUsageReceipt = (input: IssueReceiptInput): string => {
  const claims = receiptClaimsSchema.parse({
    purpose: 'inference-usage-receipt',
    version: 1,
    eventId: input.eventId,
    userId: input.userId,
    provider: input.price.provider,
    model: input.price.model,
    inputNanoUsdPerToken: input.price.inputNanoUsdPerToken.toString(),
    outputNanoUsdPerToken: input.price.outputNanoUsdPerToken.toString(),
    issuedAt: input.nowSeconds,
    expiresAt: input.nowSeconds + receiptLifetimeSeconds,
  })
  const payloadSegment = encodeReceiptPayload(claims)
  const signingInput = `iu1.${payloadSegment}`
  const signatureSegment = signReceiptInput(signingInput, input.secret).toString('base64url')

  return `${signingInput}.${signatureSegment}`
}

/** Verify a signed confidential managed usage receipt. */
export const verifyInferenceUsageReceipt = (
  token: string,
  secret: string,
  nowSeconds: number,
): InferenceUsageReceiptClaims | null => {
  const segments = token.split('.')
  if (segments.length !== 3) {
    return null
  }

  const [prefix, payloadSegment, signatureSegment] = segments
  if (
    prefix !== 'iu1' ||
    !payloadSegment ||
    !signatureSegment ||
    !isBase64UrlSegment(payloadSegment) ||
    !isBase64UrlSegment(signatureSegment)
  ) {
    return null
  }

  const signature = Buffer.from(signatureSegment, 'base64url')
  const expectedSignature = signReceiptInput(`iu1.${payloadSegment}`, secret)
  if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
    return null
  }

  try {
    const parsed = receiptClaimsSchema.safeParse(JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')))
    if (
      !parsed.success ||
      parsed.data.issuedAt > nowSeconds + receiptFutureSkewSeconds ||
      nowSeconds >= parsed.data.expiresAt
    ) {
      return null
    }

    return parsed.data
  } catch {
    return null
  }
}
