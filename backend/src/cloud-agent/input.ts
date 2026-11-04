/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { resourcePublicKeySchema } from '@shared/cloud-agent/validation'

const encoded = z.string().min(1).max(8_000_000)
export const identifier = z.string().uuid()
export const epoch = z.number().int().min(1).max(2_147_483_647)
export const ciphertextSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('scoped-payload'),
  iv: encoded,
  ciphertext: encoded,
})
export const publicKeySchema = resourcePublicKeySchema
export const envelopeSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('resource-key'),
  recipientKeyId: z.string().min(1).max(128),
  ephemeralPublicKey: encoded,
  mlkemCiphertext: encoded,
  iv: encoded,
  ciphertext: encoded,
})
export const identitySchema = z.strictObject({
  identity: z.strictObject({
    version: z.literal(1),
    accountKeyId: z.string().min(1).max(128),
    publicKey: publicKeySchema,
    ciphertext: ciphertextSchema,
  }),
})
export const saveResourceSchema = z.strictObject({
  id: identifier,
  expectedVersion: z.number().int().min(0),
  keyEpoch: epoch,
  enabled: z.boolean(),
  config: ciphertextSchema,
  ownerKeyEnvelope: envelopeSchema,
  runtimeKeyEnvelope: envelopeSchema,
})
export const submitSchema = z.strictObject({ commandId: identifier, content: ciphertextSchema, keyEpoch: epoch })
export const scheduleSchema = z.strictObject({
  id: identifier,
  agentId: identifier,
  expectedVersion: z.number().int().min(0),
  keyEpoch: epoch,
  enabled: z.boolean(),
  config: ciphertextSchema,
})
export const revisionSchema = z.strictObject({
  id: identifier,
  parentRevisionId: identifier.nullable(),
  keyEpoch: epoch,
  manifest: ciphertextSchema,
  content: ciphertextSchema,
})
