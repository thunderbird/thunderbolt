#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Standalone out-of-band decrypt tool for the Enterprise Key-Escrow POC
 * (docs/architecture/e2e-encryption.md#enterprise-kms-escrow-poc).
 *
 * The running backend app is intentionally zero-knowledge and NEVER has this
 * capability. This tool exists purely for an operator holding the org escrow
 * private key to recover one column of one row directly from Postgres, entirely
 * out-of-band:
 *
 *   org_envelopes.wrapped_ak (unwrap via ECDH+HKDF+AES-KW, using the escrow
 *   private key) -> wrapped_keys keyring (AES-KW-unwrap each DEK under the
 *   recovered AK) -> the target column's `__enc:...` wire value (AES-256-GCM
 *   decrypt with the frozen AAD layout) -> plaintext on stdout.
 *
 * Connects directly to Postgres — it does not import or bootstrap the backend
 * app, so a plain connection string is all you need.
 *
 * The escrow private key is read from `ORG_KMS_ESCROW_STATIC_PRIVATE_KEY` or
 * `--static-private-key-file`, never from argv — anything on argv is visible to
 * every other user on the box via `ps` and lands in shell history.
 *
 * This tool assumes an exportable P-256 keypair the operator holds — the only
 * arrangement the app itself supports. An operator whose escrow key lives inside
 * a KMS/HSM and cannot be exported swaps exactly one step, `deriveSharedSecret`
 * below, for that KMS's key-agreement call; everything downstream of the shared
 * secret is independent of where the key lives. See the note on that function.
 *
 * Usage:
 *   ORG_KMS_ESCROW_STATIC_PRIVATE_KEY=<base64 PKCS8 EC private key> \
 *   DATABASE_URL=postgres://user:pass@host:5432/db \
 *   bun run scripts/kms-escrow-decrypt.ts \
 *     --user-id <id> --table chat_messages --column content --row-id <id>
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import postgres from 'postgres'
// The org envelope's byte layout and HKDF parameters are imported, never
// re-declared: this tool is the only thing that inverts `wrapAKForOrg`, and a
// one-character drift between the two would make escrow silently unrecoverable.
import {
  encPrefix,
  encV2Prefix,
  encodeAAD,
  legacyKeyId,
  orgEnvelopeLength,
  orgEnvelopeVersion,
  orgKmsHkdfInfo,
  p256PointLength,
  uncompressedPointPrefix,
  type KeyId,
} from '../shared/e2ee-types'

const ecdhAlgorithm = 'ECDH'
const ecdhCurve = 'P-256'
const aesKwAlgorithm = 'AES-KW'
const aesGcmAlgorithm = 'AES-GCM'
const aesKeyLength = 256

type CliArgs = {
  userId: string
  table: string
  column: string
  rowId: string
  dbUrl: string
  staticPrivateKey: string
}

const staticPrivateKeyEnvVar = 'ORG_KMS_ESCROW_STATIC_PRIVATE_KEY'

const usage = [
  'Usage: bun run scripts/kms-escrow-decrypt.ts',
  '  --user-id <id> --table <table> --column <column> --row-id <id>',
  '  Set $DATABASE_URL or pass --db-url <postgres-url> (the env keeps the password off `ps`)',
  `  Set $${staticPrivateKeyEnvVar} (base64 PKCS8 EC key) or pass --static-private-key-file <path>`,
].join('\n')

/**
 * Parse and validate CLI args, reading the private key from the environment or a
 * file so it never appears in argv. Throws with `usage` appended on any invalid
 * combination.
 */
const parseCliArgs = (): CliArgs => {
  const { values } = parseArgs({
    options: {
      'user-id': { type: 'string' },
      table: { type: 'string' },
      column: { type: 'string' },
      'row-id': { type: 'string' },
      'db-url': { type: 'string' },
      'static-private-key-file': { type: 'string' },
    },
  })

  const {
    table,
    column,
    'user-id': userId,
    'row-id': rowId,
    'db-url': dbUrlArg,
    'static-private-key-file': privateKeyFile,
  } = values

  // The connection string carries the Postgres password, so prefer the
  // environment: anything on argv is visible to every other user via `ps`.
  const dbUrl = dbUrlArg ?? process.env.DATABASE_URL
  if (!userId || !table || !column || !rowId || !dbUrl) {
    throw new Error(`Missing required argument.\n${usage}`)
  }

  const staticPrivateKey = privateKeyFile
    ? readFileSync(privateKeyFile, 'utf8').trim()
    : process.env[staticPrivateKeyEnvVar]
  if (!staticPrivateKey) {
    throw new Error(`Provide $${staticPrivateKeyEnvVar} or --static-private-key-file.\n${usage}`)
  }
  return { userId, table, column, rowId, dbUrl, staticPrivateKey }
}

/**
 * `sql(identifier)` quotes these, but keep an allowlist in front of it: the
 * shapes below are the only ones any real table/column in this schema takes, so
 * anything else is a typo or an attempt, and both are better refused early.
 */
export const assertSafeIdentifier = (value: string, kind: 'table' | 'column'): void => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${kind} identifier: "${value}"`)
  }
}

/**
 * Derive the raw ECDH shared secret from the operator's local PKCS8 private key.
 * Mirrors `wrapAKForOrg`'s `deriveBits` call on the wrapping side.
 *
 * THIS IS THE ONE SWAPPABLE STEP. An operator whose escrow key is KMS-resident and
 * non-exportable replaces this one function with that KMS's key-agreement call,
 * and changes nothing else — the caller only needs 32 raw bytes back. Two things
 * to get right when doing so: the KMS must return the raw ECDH output with no
 * KDF applied (`deriveOrgUnwrapKey` below does the HKDF), and most KMS APIs want
 * the peer key as DER SPKI rather than the raw point stored in the envelope —
 * re-export `ephPubRaw` through `crypto.subtle` to convert.
 */
export const deriveSharedSecret = async (
  staticPrivateKeyBase64: string,
  ephPubRaw: Uint8Array,
): Promise<Uint8Array> => {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(staticPrivateKeyBase64, 'base64'),
    { name: ecdhAlgorithm, namedCurve: ecdhCurve },
    false,
    ['deriveBits'],
  )
  const ephemeralPublicKey = await crypto.subtle.importKey(
    'raw',
    ephPubRaw,
    { name: ecdhAlgorithm, namedCurve: ecdhCurve },
    false,
    [],
  )
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ephemeralPublicKey },
    privateKey,
    256,
  )
  return new Uint8Array(sharedSecret)
}

/** Split the org envelope into its ephemeral pubkey and still-wrapped AK bytes. */
export const parseOrgEnvelope = (wrappedAkBase64: string): { ephPubRaw: Uint8Array; wrappedAkBytes: Uint8Array } => {
  const envelope = new Uint8Array(Buffer.from(wrappedAkBase64, 'base64'))
  // Length first: a truncated envelope would otherwise report a bogus version
  // byte (or `undefined`) and send the operator hunting the wrong problem.
  if (envelope.length !== orgEnvelopeLength) {
    throw new Error(`Malformed org envelope: expected ${orgEnvelopeLength} bytes, got ${envelope.length}`)
  }
  if (envelope[0] !== orgEnvelopeVersion) {
    throw new Error(`Unsupported org envelope version: ${envelope[0]}`)
  }
  if (envelope[1] !== uncompressedPointPrefix) {
    throw new Error('Malformed org envelope: ephemeral key is not an uncompressed P-256 point')
  }
  return {
    ephPubRaw: envelope.slice(1, 1 + p256PointLength),
    wrappedAkBytes: envelope.slice(1 + p256PointLength),
  }
}

/**
 * HKDF-SHA256(sharedSecret, salt=ephPubRaw, info=orgKmsHkdfInfo) -> AES-KW-256
 * unwrapping key. Must match `wrapAKForOrg`'s derivation exactly.
 */
export const deriveOrgUnwrapKey = async (sharedSecret: Uint8Array, ephPubRaw: Uint8Array): Promise<CryptoKey> => {
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ephPubRaw, info: orgKmsHkdfInfo },
    hkdfKey,
    { name: aesKwAlgorithm, length: aesKeyLength },
    false,
    ['unwrapKey'],
  )
}

/** AES-KW-unwrap the AK, non-extractable, usable only to unwrap the DEK keyring. */
export const unwrapAk = (wrappedAkBytes: Uint8Array, unwrapKey: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.unwrapKey(
    'raw',
    wrappedAkBytes,
    unwrapKey,
    aesKwAlgorithm,
    { name: aesKwAlgorithm, length: aesKeyLength },
    false,
    ['unwrapKey'],
  )

/** AES-KW-unwrap one DEK (base64) under the recovered AK. */
export const unwrapDek = (wrappedKeyBase64: string, ak: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.unwrapKey(
    'raw',
    Buffer.from(wrappedKeyBase64, 'base64'),
    ak,
    aesKwAlgorithm,
    { name: aesGcmAlgorithm, length: aesKeyLength },
    false,
    ['decrypt'],
  )

export type ParsedEncryptedValue = { keyId: KeyId; iv: Uint8Array; ciphertext: Uint8Array; aad?: Uint8Array }

/**
 * Parse the target column's wire value (v2 `__enc:v2:<key_id>:<iv>:<ct>`, or
 * legacy v1 `__enc:<iv>:<ct>` with no AAD) into its decrypt inputs.
 */
export const parseEncryptedValue = (
  value: string,
  ctx: { table: string; column: string; rowId: string },
): ParsedEncryptedValue => {
  if (value.startsWith(encV2Prefix)) {
    const [keyId, iv, ciphertext, ...rest] = value.slice(encV2Prefix.length).split(':')
    if (!keyId || !iv || !ciphertext || rest.length > 0) {
      throw new Error(`Malformed v2 encrypted value at ${ctx.table}.${ctx.column}`)
    }
    return {
      keyId,
      iv: new Uint8Array(Buffer.from(iv, 'base64')),
      ciphertext: new Uint8Array(Buffer.from(ciphertext, 'base64')),
      aad: encodeAAD(ctx.table, ctx.column, ctx.rowId, keyId),
    }
  }
  if (value.startsWith(encPrefix)) {
    const [iv, ciphertext, ...rest] = value.slice(encPrefix.length).split(':')
    if (!iv || !ciphertext || rest.length > 0) {
      throw new Error(`Malformed legacy encrypted value at ${ctx.table}.${ctx.column}`)
    }
    return {
      keyId: legacyKeyId,
      iv: new Uint8Array(Buffer.from(iv, 'base64')),
      ciphertext: new Uint8Array(Buffer.from(ciphertext, 'base64')),
    }
  }
  throw new Error(`Column value at ${ctx.table}.${ctx.column} is not an encrypted (${encPrefix}) value`)
}

/** AES-256-GCM decrypt, binding the AAD when present (v2 only — v1 was written with none). */
export const decryptValue = async (parsed: ParsedEncryptedValue, dek: CryptoKey): Promise<string> => {
  const plaintext = await crypto.subtle.decrypt(
    { name: aesGcmAlgorithm, iv: parsed.iv, ...(parsed.aad && { additionalData: parsed.aad }) },
    dek,
    parsed.ciphertext,
  )
  return new TextDecoder().decode(plaintext)
}

type EscrowInputs = { wrappedAkBase64: string; keyring: Map<KeyId, string>; wireValue: string }

/**
 * Read everything this recovery needs from Postgres. `search_path` covers both
 * schemas because the key tables live in `public` while synced user-content
 * tables live in `powersync`, and `--table`/`--column` are unqualified.
 */
const loadEscrowInputs = async (sql: postgres.Sql, args: CliArgs): Promise<EscrowInputs> => {
  const envelopeRows = await sql<{ wrapped_ak: string }[]>`
    SELECT wrapped_ak FROM org_envelopes WHERE user_id = ${args.userId}
  `
  const wrappedAkBase64 = envelopeRows[0]?.wrapped_ak
  if (!wrappedAkBase64) {
    throw new Error(
      `No org_envelopes row for user ${args.userId} — escrow was not enabled when this account last produced an account key.`,
    )
  }

  const keyringRows = await sql<{ key_id: string; wrapped_key: string }[]>`
    SELECT key_id, wrapped_key FROM wrapped_keys WHERE user_id = ${args.userId}
  `
  if (keyringRows.length === 0) {
    throw new Error(`No wrapped_keys rows for user ${args.userId}`)
  }

  const rowResult = await sql<Record<string, string | null>[]>`
    SELECT ${sql(args.column)} FROM ${sql(args.table)} WHERE id = ${args.rowId}
  `
  const wireValue = rowResult[0]?.[args.column]
  if (wireValue == null) {
    throw new Error(`No value at ${args.table}.${args.column} for row ${args.rowId}`)
  }

  return {
    wrappedAkBase64,
    keyring: new Map(keyringRows.map((row) => [row.key_id, row.wrapped_key])),
    wireValue,
  }
}

/**
 * Invert the escrow chain: org envelope -> AK -> the one DEK this value needs ->
 * plaintext. Only the referenced `key_id` is unwrapped, so an unrelated keyring
 * slot that won't unwrap can't fail a recovery that would otherwise succeed.
 */
const recoverPlaintext = async (args: CliArgs, inputs: EscrowInputs): Promise<string> => {
  const { ephPubRaw, wrappedAkBytes } = parseOrgEnvelope(inputs.wrappedAkBase64)
  const sharedSecret = await deriveSharedSecret(args.staticPrivateKey, ephPubRaw)
  const orgUnwrapKey = await deriveOrgUnwrapKey(sharedSecret, ephPubRaw)
  const ak = await unwrapAk(wrappedAkBytes, orgUnwrapKey).catch((cause) => {
    throw new Error('Failed to unwrap the account key — is this the escrow key this envelope was wrapped for?', {
      cause,
    })
  })

  const parsed = parseEncryptedValue(inputs.wireValue, {
    table: args.table,
    column: args.column,
    rowId: args.rowId,
  })
  const wrappedDek = inputs.keyring.get(parsed.keyId)
  if (!wrappedDek) {
    throw new Error(`No DEK for key_id "${parsed.keyId}" in this account's keyring`)
  }
  const dek = await unwrapDek(wrappedDek, ak)
  return decryptValue(parsed, dek)
}

const main = async (): Promise<void> => {
  const args = parseCliArgs()
  assertSafeIdentifier(args.table, 'table')
  assertSafeIdentifier(args.column, 'column')

  // `search_path` covers both schemas so the unqualified `--table` resolves:
  // synced user content lives in `powersync`, the key tables in `public`.
  const sql = postgres(args.dbUrl, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: 'powersync,public' },
  })
  try {
    console.log(await recoverPlaintext(args, await loadEscrowInputs(sql, args)))
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    // The whole error, not just `.message`: the likeliest failure here is a
    // WebCrypto OperationError whose message is empty, and whose `cause` is the
    // only thing that tells the operator what actually went wrong.
    console.error(err)
    process.exit(1)
  }
}
