/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

export type ResourcePublicIdentity = {
  version: 1
  keyId: string
  ecdhPublicKey: string
  mlkemPublicKey: string
}

export type ResourcePublicKey = ResourcePublicIdentity

/** Private material is a boot secret or an owner-encrypted payload, never a public configuration field. */
export type ResourceIdentity = {
  publicKey: ResourcePublicIdentity
  ecdhPrivateKey: string
  mlkemSecretKey: string
}

/** Validate serialized recipient material at storage/configuration boundaries. Cryptographic key validation occurs on use. */
export const parseResourceIdentity = (value: unknown): ResourceIdentity => {
  if (typeof value !== 'object' || value === null || !('publicKey' in value)) {
    throw new Error('Invalid resource identity')
  }
  const publicKey = value.publicKey
  if (
    typeof publicKey !== 'object' ||
    publicKey === null ||
    !('version' in publicKey) ||
    publicKey.version !== 1 ||
    !('keyId' in publicKey) ||
    typeof publicKey.keyId !== 'string' ||
    !publicKey.keyId ||
    !('ecdhPublicKey' in publicKey) ||
    typeof publicKey.ecdhPublicKey !== 'string' ||
    !('mlkemPublicKey' in publicKey) ||
    typeof publicKey.mlkemPublicKey !== 'string' ||
    !('ecdhPrivateKey' in value) ||
    typeof value.ecdhPrivateKey !== 'string' ||
    !('mlkemSecretKey' in value) ||
    typeof value.mlkemSecretKey !== 'string'
  ) {
    throw new Error('Invalid resource identity')
  }
  return {
    publicKey: {
      version: 1,
      keyId: publicKey.keyId,
      ecdhPublicKey: publicKey.ecdhPublicKey,
      mlkemPublicKey: publicKey.mlkemPublicKey,
    },
    ecdhPrivateKey: value.ecdhPrivateKey,
    mlkemSecretKey: value.mlkemSecretKey,
  }
}

export type ResourceKeyContext = {
  ownerId: string
  scopeId: string
  keyEpoch: number
  recipientId: string
}

export type ScopedPayloadContext = {
  ownerId: string
  scopeId: string
  keyEpoch: number
  recordId: string
  purpose: string
}

export type ScopedCiphertext = {
  version: 1
  kind: 'scoped-payload'
  iv: string
  ciphertext: string
}

export type ResourceKeyEnvelope = {
  version: 1
  kind: 'resource-key'
  recipientKeyId: string
  ephemeralPublicKey: string
  mlkemCiphertext: string
  iv: string
  ciphertext: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const ivLength = 12
const keyLength = 32
const envelopeDomain = 'thunderbolt-resource-envelope-v1'
const payloadDomain = 'thunderbolt-scoped-payload-v1'

/** A format version fixes its cipher and key size rather than accepting a weaker imported key. */
const assertResourceKey = (key: CryptoKey): void => {
  if (key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) {
    throw new Error('Resource keys must be AES-256-GCM')
  }
}

/** Encode bytes without depending on Node globals or overflowing the argument stack. */
const toBase64 = (bytes: Uint8Array): string =>
  btoa(
    Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, index) =>
      String.fromCharCode(...bytes.subarray(index * 0x8000, (index + 1) * 0x8000)),
    ).join(''),
  )

/** Reject noncanonical encodings so an identity has one serialized representation. */
const fromBase64 = (value: string, length?: number): Uint8Array<ArrayBuffer> => {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  if (toBase64(bytes) !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error('Invalid resource crypto encoding')
  }
  return bytes
}

/** Length-prefix through JSON instead of delimiter concatenation, including caller-supplied identifiers. */
const contextBytes = (domain: string, values: readonly (string | number)[]) =>
  encoder.encode(JSON.stringify([domain, ...values]))

/** Fail closed on absent scope identifiers and invalid key epochs. */
const assertScope = (context: Pick<ResourceKeyContext, 'ownerId' | 'scopeId' | 'keyEpoch'>): void => {
  if (!context.ownerId || !context.scopeId || !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1) {
    throw new Error('Invalid resource crypto scope')
  }
}

/** Authenticate all public identity fields as well as the intended grant recipient. */
const envelopeAad = (context: ResourceKeyContext, recipient: ResourcePublicIdentity): Uint8Array<ArrayBuffer> => {
  assertScope(context)
  if (!context.recipientId || recipient.version !== 1 || !recipient.keyId) {
    throw new Error('Invalid resource crypto recipient')
  }
  return contextBytes(envelopeDomain, [
    context.ownerId,
    context.scopeId,
    context.keyEpoch,
    context.recipientId,
    recipient.keyId,
    recipient.ecdhPublicKey,
    recipient.mlkemPublicKey,
  ])
}

/** Bind payloads to their owner, scope, key epoch and exact record role. */
const payloadAad = (context: ScopedPayloadContext): Uint8Array<ArrayBuffer> => {
  assertScope(context)
  if (!context.recordId || !context.purpose) {
    throw new Error('Invalid resource payload context')
  }
  return contextBytes(payloadDomain, [
    context.ownerId,
    context.scopeId,
    context.keyEpoch,
    context.recordId,
    context.purpose,
  ])
}

/** Import the existing P-256 public-key representation with no private-key capability. */
const importPublicKey = (value: string) =>
  crypto.subtle.importKey('raw', fromBase64(value, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, [])

/** Use the existing P-256 + ML-KEM-768 combiner with a separate resource-envelope derivation domain. */
const deriveEnvelopeKey = async (
  classicalSecret: ArrayBuffer,
  quantumSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  kemCiphertext: Uint8Array,
): Promise<CryptoKey> => {
  const combined = new Uint8Array(64)
  combined.set(new Uint8Array(classicalSecret))
  combined.set(quantumSecret, 32)
  const salt = new Uint8Array(ephemeralPublicKey.length + kemCiphertext.length)
  salt.set(ephemeralPublicKey)
  salt.set(kemCiphertext, ephemeralPublicKey.length)
  try {
    const material = await crypto.subtle.importKey('raw', combined, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(envelopeDomain) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    combined.fill(0)
    quantumSecret.fill(0)
    new Uint8Array(classicalSecret).fill(0)
  }
}

/** Generate an independently rotatable resource recipient, suitable for encrypted owner storage or a runtime boot secret. */
export const generateResourceIdentity = async (): Promise<ResourceIdentity> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const kem = ml_kem768.keygen()
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  try {
    return {
      publicKey: {
        version: 1,
        keyId: crypto.randomUUID(),
        ecdhPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
        mlkemPublicKey: toBase64(kem.publicKey),
      },
      ecdhPrivateKey: toBase64(privateBytes),
      mlkemSecretKey: toBase64(kem.secretKey),
    }
  } finally {
    privateBytes.fill(0)
    kem.secretKey.fill(0)
  }
}

/** Generate an extractable resource key for its initial owner/runtime envelopes; never persist the raw key. */
export const generateResourceKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

/** Seal a resource key to one explicitly identified recipient without granting any account key. */
export const sealResourceKey = async (
  key: CryptoKey,
  recipient: ResourcePublicIdentity,
  context: ResourceKeyContext,
): Promise<ResourceKeyEnvelope> => {
  assertResourceKey(key)
  const aad = envelopeAad(context, recipient)
  const publicKey = await importPublicKey(recipient.ecdhPublicKey)
  const kem = ml_kem768.encapsulate(fromBase64(recipient.mlkemPublicKey, 1184))
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const ephemeralBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const classical = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, ephemeral.privateKey, 256)
  const sealingKey = await deriveEnvelopeKey(classical, kem.sharedSecret, ephemeralBytes, kem.cipherText)
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, sealingKey, raw)
    return {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: recipient.keyId,
      ephemeralPublicKey: toBase64(ephemeralBytes),
      mlkemCiphertext: toBase64(kem.cipherText),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    }
  } finally {
    raw.fill(0)
  }
}

/** Open an assigned resource key. Exportability is opt-in only when a new authorized envelope must be created. */
export const openResourceKey = async (
  envelope: ResourceKeyEnvelope,
  identity: ResourceIdentity,
  context: ResourceKeyContext,
  extractable = false,
): Promise<CryptoKey> => {
  if (
    envelope.version !== 1 ||
    envelope.kind !== 'resource-key' ||
    envelope.recipientKeyId !== identity.publicKey.keyId
  ) {
    throw new Error('Unsupported or mismatched resource key envelope')
  }
  const aad = envelopeAad(context, identity.publicKey)
  const privateBytes = fromBase64(identity.ecdhPrivateKey)
  const kemSecret = fromBase64(identity.mlkemSecretKey, 2400)
  const raw = await (async () => {
    try {
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        privateBytes,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      )
      const ephemeralBytes = fromBase64(envelope.ephemeralPublicKey, 65)
      const ephemeralKey = await importPublicKey(envelope.ephemeralPublicKey)
      const kemCiphertext = fromBase64(envelope.mlkemCiphertext, 1088)
      const classical = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeralKey }, privateKey, 256)
      const quantum = ml_kem768.decapsulate(kemCiphertext, kemSecret)
      const sealingKey = await deriveEnvelopeKey(classical, quantum, ephemeralBytes, kemCiphertext)
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(envelope.iv, ivLength), additionalData: aad },
          sealingKey,
          fromBase64(envelope.ciphertext, keyLength + 16),
        ),
      )
    } finally {
      privateBytes.fill(0)
      kemSecret.fill(0)
    }
  })()
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, extractable, [
      'encrypt',
      'decrypt',
    ])
  } finally {
    raw.fill(0)
  }
}

/** Encrypt artifact bytes with a fresh IV and authenticated resource context. */
export const encryptScopedBytes = async (
  value: Uint8Array,
  key: CryptoKey,
  context: ScopedPayloadContext,
): Promise<ScopedCiphertext> => {
  assertResourceKey(key)
  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: payloadAad(context) },
    key,
    new Uint8Array(value),
  )
  return { version: 1, kind: 'scoped-payload', iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }
}

/** Decrypt only the record context supplied by the authorized caller, never a context taken from the ciphertext. */
export const decryptScopedBytes = async (
  value: ScopedCiphertext,
  key: CryptoKey,
  context: ScopedPayloadContext,
): Promise<Uint8Array<ArrayBuffer>> => {
  assertResourceKey(key)
  if (value.version !== 1 || value.kind !== 'scoped-payload') {
    throw new Error('Unsupported scoped payload format')
  }
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(value.iv, ivLength), additionalData: payloadAad(context) },
      key,
      fromBase64(value.ciphertext),
    ),
  )
}

/** Encrypt JSON; callers keep schemas at their domain boundary rather than trusting decrypted types. */
export const encryptScopedJson = async (
  value: unknown,
  key: CryptoKey,
  context: ScopedPayloadContext,
): Promise<ScopedCiphertext> => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error('Scoped payload must be JSON serializable')
  }
  return encryptScopedBytes(encoder.encode(serialized), key, context)
}

/** Decrypt JSON as unknown so persistence/network boundaries must validate their actual domain schema. */
export const decryptScopedJson = async (
  value: ScopedCiphertext,
  key: CryptoKey,
  context: ScopedPayloadContext,
): Promise<unknown> => JSON.parse(decoder.decode(await decryptScopedBytes(value, key, context))) as unknown

/** Fingerprint a recipient's canonical public identity for trusted binding and rotation checks. */
export const resourceIdentityFingerprint = async (identity: ResourcePublicIdentity): Promise<string> => {
  if (identity.version !== 1 || !identity.keyId) {
    throw new Error('Invalid resource public identity')
  }
  await importPublicKey(identity.ecdhPublicKey)
  ml_kem768.encapsulate(fromBase64(identity.mlkemPublicKey, 1184))
  const digest = await crypto.subtle.digest(
    'SHA-256',
    contextBytes('thunderbolt-resource-identity-v1', [identity.keyId, identity.ecdhPublicKey, identity.mlkemPublicKey]),
  )
  return toBase64(new Uint8Array(digest))
}

/** Derive a private lookup token in a separate HKDF/HMAC domain; the runtime must explicitly open its resource key as extractable. */
export const indexScopedValue = async (
  value: string,
  key: CryptoKey,
  context: Omit<ScopedPayloadContext, 'recordId'>,
): Promise<string> => {
  assertResourceKey(key)
  assertScope(context)
  if (!context.purpose) {
    throw new Error('Private index requires a purpose')
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  try {
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
    const indexKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: contextBytes('thunderbolt-resource-private-index-v1', [
          context.ownerId,
          context.scopeId,
          context.keyEpoch,
          context.purpose,
        ]),
      },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    )
    return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', indexKey, encoder.encode(value))))
  } finally {
    raw.fill(0)
  }
}
