#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Org Escrow Decrypt (THU-804 POC)
 *
 * Standalone operator recovery tool: given the offline escrow PRIVATE key,
 * recovers a user's Account Key from their `org_envelopes` row, unwraps the DEK
 * keyring, and decrypts one encrypted cell. Talks directly to Postgres — never
 * imports or boots the backend app.
 *
 * Only the recovered plaintext is written to stdout; all diagnostics go to
 * stderr, so callers (e.g. the e2e suite) can capture stdout cleanly.
 *
 * Usage:
 *   bun scripts/org-escrow-decrypt.ts \
 *     --user-id <id> --table <table> --column <column> --row-id <id> \
 *     --db-url postgresql://... --private-key <base64-pkcs8>
 */

import { parseArgs } from 'node:util'
import postgres from 'postgres'
import {
  encPrefix,
  encV2Prefix,
  encodeAAD,
  encryptedColumnsMap,
  legacyKeyId,
  orgEnvelopeVersion,
  orgEscrowHkdfInfo,
  p256RawPublicKeyLength,
  type EncryptionContext,
  type KeyId,
  type WrappedKeyEntry,
} from '../shared/e2ee-types'

/** AES-KW of a 32-byte key adds an 8-byte integrity block. */
const wrappedAkLength = 40

/** Parsed org-escrow envelope: `[version 1B][ephPubRaw 65B][wrappedAk 40B]`. */
export type OrgEnvelope = {
  ephPubRaw: Uint8Array
  wrappedAk: Uint8Array
}

const base64ToBytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'))

/**
 * Parse and validate a base64 org-escrow envelope per the frozen wire contract.
 * Throws on a version or length mismatch — a malformed envelope means the DB
 * row was not written by the THU-804 wrap path.
 */
export const parseOrgEnvelope = (wrappedAkBase64: string): OrgEnvelope => {
  const envelope = base64ToBytes(wrappedAkBase64)
  const expectedLength = 1 + p256RawPublicKeyLength + wrappedAkLength
  if (envelope.length !== expectedLength) {
    throw new Error(`Invalid org envelope: ${envelope.length} bytes, expected ${expectedLength}`)
  }
  if (envelope[0] !== orgEnvelopeVersion) {
    throw new Error(`Unsupported org envelope version: 0x${envelope[0].toString(16).padStart(2, '0')}`)
  }
  return {
    ephPubRaw: envelope.slice(1, 1 + p256RawPublicKeyLength),
    wrappedAk: envelope.slice(1 + p256RawPublicKeyLength),
  }
}

/**
 * Recover the Account Key from a parsed envelope using the operator's offline
 * private key: ECDH(ephemeralPub, operatorPriv) → HKDF-SHA256(info =
 * orgEscrowHkdfInfo, salt = ephPubRaw) → AES-KW-256 → unwrap the AK.
 */
export const unwrapEscrowedAK = async (envelope: OrgEnvelope, privateKeyBase64: string): Promise<CryptoKey> => {
  const operatorPrivateKey = await crypto.subtle
    .importKey('pkcs8', base64ToBytes(privateKeyBase64) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])
    .catch((err: unknown) => {
      throw new Error('Failed to import the operator private key — expected base64 PKCS8 ECDH P-256', { cause: err })
    })
  const ephemeralPublicKey = await crypto.subtle.importKey(
    'raw',
    envelope.ephPubRaw as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeralPublicKey }, operatorPrivateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  const kwKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: envelope.ephPubRaw as BufferSource,
      info: new TextEncoder().encode(orgEscrowHkdfInfo),
    },
    hkdfKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['unwrapKey'],
  )
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      envelope.wrappedAk as BufferSource,
      kwKey,
      'AES-KW',
      'AES-KW',
      false,
      ['unwrapKey'],
    )
  } catch (err) {
    throw new Error(
      'Failed to unwrap the Account Key — the private key does not match the escrow envelope ' +
        '(wrong operator key, or the account rotated its AK while escrow was disabled)',
      { cause: err },
    )
  }
}

/**
 * Unwrap the full DEK keyring under the recovered AK. Each `wrapped_key` is
 * base64 AES-KW(DEK); DEKs are AES-256-GCM decrypt-only.
 */
export const unwrapKeyring = async (entries: WrappedKeyEntry[], ak: CryptoKey): Promise<Map<KeyId, CryptoKey>> => {
  const deks = new Map<KeyId, CryptoKey>()
  for (const { keyId, wrappedKey } of entries) {
    try {
      const dek = await crypto.subtle.unwrapKey(
        'raw',
        base64ToBytes(wrappedKey) as BufferSource,
        ak,
        'AES-KW',
        'AES-GCM',
        false,
        ['decrypt'],
      )
      deks.set(keyId, dek)
    } catch (err) {
      throw new Error(`Failed to unwrap DEK "${keyId}" — the keyring was re-wrapped under a different AK`, {
        cause: err,
      })
    }
  }
  return deks
}

export type DecryptedCell = {
  plaintext: string
  /** False when the stored value carried no `__enc:` prefix (returned as-is). */
  wasEncrypted: boolean
}

/**
 * Decrypt one stored cell value. Dispatches on the wire format:
 * - v2 `__enc:v2:<key_id>:<iv>:<ct>` — AES-256-GCM with the DEK for `key_id`
 *   and AAD = encodeAAD(table, column, rowId, keyId)
 * - legacy v1 `__enc:<iv>:<ct>` — the reserved `"v1"` DEK, NO AAD
 * - anything else — plaintext, returned unchanged with `wasEncrypted: false`
 */
export const decryptCellValue = async (
  value: string,
  deks: Map<KeyId, CryptoKey>,
  ctx: EncryptionContext,
): Promise<DecryptedCell> => {
  if (!value.startsWith(encPrefix)) {
    return { plaintext: value, wasEncrypted: false }
  }

  const decrypt = async (keyId: KeyId, ivBase64: string, ctBase64: string, additionalData?: Uint8Array) => {
    const dek = deks.get(keyId)
    if (!dek) {
      throw new Error(`No DEK "${keyId}" in the keyring (have: ${[...deks.keys()].join(', ') || 'none'})`)
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(ivBase64) as BufferSource, additionalData: additionalData as BufferSource },
        dek,
        base64ToBytes(ctBase64) as BufferSource,
      )
      return new TextDecoder().decode(plaintext)
    } catch (err) {
      throw new Error(
        `AES-GCM decryption failed for key "${keyId}" — ciphertext corrupt or AAD mismatch ` +
          `(table/column/row-id must match what the value was encrypted under)`,
        { cause: err },
      )
    }
  }

  if (value.startsWith(encV2Prefix)) {
    const segments = value.slice(encV2Prefix.length).split(':')
    if (segments.length !== 3) {
      throw new Error(`Malformed v2 encrypted value: expected __enc:v2:<key_id>:<iv>:<ct>`)
    }
    const [keyId, iv, ct] = segments
    const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, keyId)
    return { plaintext: await decrypt(keyId, iv, ct, aad), wasEncrypted: true }
  }

  const segments = value.slice(encPrefix.length).split(':')
  if (segments.length !== 2) {
    throw new Error(`Malformed v1 encrypted value: expected __enc:<iv>:<ct>`)
  }
  const [iv, ct] = segments
  return { plaintext: await decrypt(legacyKeyId, iv, ct), wasEncrypted: true }
}

// =============================================================================
// CLI
// =============================================================================

const usage = `Org Escrow Decrypt (THU-804 POC)

Recovers a user's Account Key from their org escrow envelope and decrypts one
encrypted cell. Requires the operator's OFFLINE escrow private key.

Usage:
  bun scripts/org-escrow-decrypt.ts \\
    --user-id <user id> \\
    --table <table> --column <column> --row-id <row id> \\
    --db-url postgresql://user:pass@host:port/db \\
    --private-key <base64 PKCS8 operator private key>

Allowed --table/--column pairs (from shared/e2ee-types.ts encryptedColumnsMap):
${Object.entries(encryptedColumnsMap)
  .map(([table, columns]) => `  ${table}: ${columns.join(', ')}`)
  .join('\n')}

Only the recovered plaintext is printed to stdout; diagnostics go to stderr.`

type CliArgs = {
  userId: string
  table: string
  column: string
  rowId: string
  dbUrl: string
  privateKey: string
}

const parseCliArgs = (): CliArgs => {
  const fail = (message: string): never => {
    console.error(`Error: ${message}\n`)
    console.error(usage)
    process.exit(1)
  }

  const parsed = (() => {
    try {
      return parseArgs({
        options: {
          'user-id': { type: 'string' },
          table: { type: 'string' },
          column: { type: 'string' },
          'row-id': { type: 'string' },
          'db-url': { type: 'string' },
          'private-key': { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })()

  if (parsed.values.help) {
    console.error(usage)
    process.exit(0)
  }

  const required = ['user-id', 'table', 'column', 'row-id', 'db-url', 'private-key'] as const
  const missing = required.filter((name) => !parsed.values[name])
  if (missing.length > 0) {
    fail(`missing required argument(s): ${missing.map((name) => `--${name}`).join(', ')}`)
  }

  const { table, column } = parsed.values
  const allowedColumns = encryptedColumnsMap[table!]
  if (!allowedColumns) {
    fail(`unknown table "${table}" — allowed: ${Object.keys(encryptedColumnsMap).join(', ')}`)
  }
  if (!allowedColumns!.includes(column!)) {
    fail(`column "${column}" is not an encrypted column of "${table}" — allowed: ${allowedColumns!.join(', ')}`)
  }

  return {
    userId: parsed.values['user-id']!,
    table: table!,
    column: column!,
    rowId: parsed.values['row-id']!,
    dbUrl: parsed.values['db-url']!,
    privateKey: parsed.values['private-key']!,
  }
}

const main = async (): Promise<void> => {
  const args = parseCliArgs()
  const sql = postgres(args.dbUrl, { max: 1, onnotice: () => {} })

  try {
    const envelopeRows = await sql<{ wrapped_ak: string; key_fingerprint: string }[]>`
      SELECT wrapped_ak, key_fingerprint FROM org_envelopes WHERE user_id = ${args.userId}
    `
    const envelopeRow = envelopeRows[0]
    if (!envelopeRow) {
      throw new Error(
        `No org escrow envelope for user ${args.userId} — the account was set up before escrow was enabled, ` +
          'or ORG_ESCROW_ENABLED was never turned on',
      )
    }
    console.error(`Found org envelope (key fingerprint ${envelopeRow.key_fingerprint})`)

    const ak = await unwrapEscrowedAK(parseOrgEnvelope(envelopeRow.wrapped_ak), args.privateKey)
    console.error('Account Key recovered')

    const keyRows = await sql<{ key_id: string; wrapped_key: string }[]>`
      SELECT key_id, wrapped_key FROM wrapped_keys WHERE user_id = ${args.userId}
    `
    if (keyRows.length === 0) {
      throw new Error(`No wrapped_keys rows for user ${args.userId} — the account has no v2 keyring`)
    }
    const deks = await unwrapKeyring(
      keyRows.map((row) => ({ keyId: row.key_id, wrappedKey: row.wrapped_key })),
      ak,
    )
    console.error(`Keyring unwrapped (${deks.size} DEK(s): ${[...deks.keys()].join(', ')})`)

    // Data tables live in the `powersync` Postgres schema; identifiers are safe —
    // both were validated against encryptedColumnsMap above.
    const valueRows = await sql<Record<string, string | null>[]>`
      SELECT ${sql(args.column)} FROM ${sql(`powersync.${args.table}`)} WHERE id = ${args.rowId}
    `
    const valueRow = valueRows[0]
    if (!valueRow) {
      throw new Error(`No row with id ${args.rowId} in powersync.${args.table}`)
    }
    const value = valueRow[args.column]
    if (value === null || value === undefined) {
      throw new Error(`Row ${args.rowId} has NULL in ${args.table}.${args.column}`)
    }

    const result = await decryptCellValue(value, deks, { table: args.table, column: args.column, rowId: args.rowId })
    if (!result.wasEncrypted) {
      console.error('Note: the stored value was not encrypted — printing it as-is')
    }
    console.log(result.plaintext)
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  await main()
}
