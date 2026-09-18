/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DataTransformMiddleware, SyncDataBucket } from '../TransformableBucketStorage'
import { codec as defaultCodec, hasStagedAK } from '@/db/encryption/codec'
import { isEncryptedValue } from '@/db/encryption/wire-format'
import { encryptedColumnsMap, type EncryptionCodec, type EncryptionContext } from '@shared/e2ee-types'

type SyncEntry = SyncDataBucket['data'][number]

/**
 * Plaintext quarantine (THU-874) — the download-side half of the plaintext
 * contract. On an account whose device holds an Account Key, every legitimate
 * writer encrypts the columns in `encryptedColumnsMap` on upload and the server
 * rejects plaintext uploads to them — so a NON-`__enc:` value arriving in a
 * mapped column via sync has exactly one possible author: the server itself.
 * Persisting it verbatim is what let a malicious server steer inference to its
 * own endpoint (and exfiltrate a BYOK key) by rewriting a `models.url`.
 *
 * Returns the first offending column, or null when the entry is clean.
 *
 * The acceptance rule is any `__enc:` prefix — v2 AND legacy v1, which the
 * reserved `"v1"` DEK slot decrypts forever (dual-read). Non-string, non-null
 * values are violations too: legitimate current writers only ever produce
 * `__enc:` strings or null in mapped columns, and a smuggled JSON object or
 * number would surface as a usable plaintext string through the SQLite view.
 *
 * What this deliberately does NOT change:
 * - Decryption stays map-blind (`decryptEntry` scans for the prefix), so a
 *   stale bundle still decrypts columns it does not know are encrypted. The
 *   map is consulted only to DETECT plaintext — and there a stale bundle fails
 *   open per unknown column, converging when the app updates.
 * - A2 deleting rows, or deleting-and-reinserting them as plaintext (the
 *   reinsert is quarantined), can hide data. That is a plain DoS the server
 *   has anyway — it can withhold any row outright — never a disclosure.
 *
 * RULE THIS CREATES for future schema work: adding a column or table to
 * `encryptedColumnsMap` when plaintext rows for it already exist server-side
 * requires a re-encryption pass in the same change (see the agents re-save,
 * `src/lib/reencrypt-agents.ts`), or established accounts' historical rows will
 * be quarantined on every device enrolled afterwards.
 */
/**
 * Tables whose mapped columns have a LEGITIMATE plaintext writer and are
 * therefore not quarantined. `devices`: the row is inserted by the backend at
 * `POST /devices` with the plaintext name the registering device sent — a
 * device that at that moment holds NO keys (registration precedes approval and
 * key delivery), so it structurally cannot encrypt. The map entry still
 * governs upload encoding (a rename through the UI encrypts), which is why the
 * table stays in `encryptedColumnsMap` at all. Exempting it costs little: a
 * server-injected plaintext `devices.name` changes a display label, not a
 * routing or content column. Anything added here needs the same two-part
 * justification — a structural plaintext writer, and a payoff-free column.
 */
const quarantineExemptTables = new Set(['devices'])

const plaintextViolation = (entry: SyncEntry, row: Record<string, unknown>): string | null => {
  if (entry.op !== 'PUT') {
    return null
  }
  if (quarantineExemptTables.has(entry.object_type ?? '')) {
    return null
  }
  const columns = encryptedColumnsMap[entry.object_type ?? '']
  if (!columns) {
    return null
  }
  for (const column of columns) {
    const value = row[column]
    if (value == null) {
      continue
    }
    if (typeof value === 'string' && isEncryptedValue(value)) {
      continue
    }
    return column
  }
  return null
}

/**
 * Suppress a quarantined entry by flipping it to a MOVE op. The op_id and
 * server-supplied checksum are KEPT: the sync protocol sums per-op checksums
 * against the checkpoint, so dropping the entry outright would fail checkpoint
 * validation and wedge sync, while a MOVE consumes the op and writes nothing.
 * Writing nothing is also what keeps the previous local value in place for an
 * updated row (the attack mutates existing rows) and avoids ever writing NULL
 * into a NOT-NULL column (`models.name`/`url`), which a later upload of the row
 * would trip over server-side and wedge the CRUD queue.
 */
const quarantineEntry = (entry: SyncEntry, column: string) => {
  console.error(
    `[EncryptionMiddleware] Quarantined a server-supplied plaintext value in encrypted column ` +
      `${entry.object_type}.${column} (row ${entry.object_id}) — sync op suppressed (THU-874)`,
  )
  entry.op = 'MOVE'
  delete entry.data
}

/**
 * Decrypt all __enc:-prefixed values in a single sync entry. Mutates `row` and
 * writes it back to entry.data.
 *
 * Intentionally data-driven rather than map-driven: any string value starting with __enc:
 * is a decode candidate regardless of whether its column appears in encryptedColumnsMap.
 * This means a stale desktop client (whose bundled map predates a new encrypted column)
 * still decrypts correctly — the __enc: prefix is the authoritative signal, not the config.
 *
 * v2 AAD threading (THU-426): each decode receives the {table, column, rowId} the upload
 * encoder bound into AAD — `object_type` is the snake_case table, the JSON key is the
 * snake_case column, `object_id` is the row id. The codec parses the wire key_id and
 * rebuilds the full `table ‖ column ‖ rowId ‖ keyId` tuple internally. Legacy v1 values
 * ignore this context (they carry no AAD), so it is passed whenever available but omitted
 * (undefined) when the entry lacks object_type/object_id — the codec then fails open on a
 * v2 value rather than decrypting under the wrong AAD, while v1 values still decode.
 */
const decryptEntry = async (entry: SyncEntry, row: Record<string, unknown>, codec: EncryptionCodec) => {
  const { object_type: table, object_id: rowId } = entry
  let changed = false

  await Promise.all(
    Object.entries(row).map(async ([key, val]) => {
      if (typeof val !== 'string' || !isEncryptedValue(val)) {
        return
      }
      const ctx: EncryptionContext | undefined = table && rowId ? { table, column: key, rowId } : undefined
      const decoded = await codec.decode(val, ctx)
      if (decoded !== val) {
        row[key] = decoded
        changed = true
      }
    }),
  )

  if (changed) {
    entry.data = JSON.stringify(row)
  }
}

const transformEntry = async (entry: SyncEntry, codec: EncryptionCodec, armed: boolean) => {
  if (!entry.data) {
    return
  }
  try {
    const row = JSON.parse(entry.data) as Record<string, unknown>

    if (armed) {
      const column = plaintextViolation(entry, row)
      if (column) {
        quarantineEntry(entry, column)
        return
      }
    }

    await decryptEntry(entry, row, codec)
  } catch (err) {
    console.warn('[EncryptionMiddleware] Failed to decrypt entry, leaving unchanged:', err)
  }
}

/**
 * Decrypts encrypted columns in sync data before it reaches SQLite, and
 * quarantines server-supplied plaintext in mapped columns (THU-874 — see
 * `plaintextViolation`).
 *
 * Decryption is data-driven: it scans all string values for the __enc: prefix rather
 * than consulting encryptedColumnsMap, so stale desktop bundles handle newly-encrypted
 * columns correctly.
 *
 * codec.decode passes plaintext through, and returns the raw ciphertext when a key
 * is unavailable — which this layer then PERSISTS as the value. That fallback is
 * only meant for a missing individual DEK (the codec self-heals over the
 * key-request channel); a device with no keyring at all must never reach here,
 * which `ThunderboltConnector.canDecryptAccountData` enforces by withholding sync
 * credentials until the keyring lands.
 *
 * The quarantine is armed by `hasStagedAK` — a client-local keyring fact, never
 * the server-supplied scheme_version (which the server could lie about to switch
 * the guard off). A genuinely pre-E2EE account has no AK, so its by-design
 * plaintext passes through untouched.
 *
 * The codec and the armed-check are injected (defaulting to the shared AES-GCM codec
 * and the real keyring fact) so tests can supply fakes without `mock.module`, which
 * leaks across test files in a non-isolated runner and corrupts the real codec's suite.
 */
export const createEncryptionMiddleware = (
  codec: EncryptionCodec = defaultCodec,
  isArmed: () => Promise<boolean> = hasStagedAK,
): DataTransformMiddleware => ({
  async transform(bucket) {
    const armed = await isArmed()
    await Promise.all(bucket.data.map((entry) => transformEntry(entry, codec, armed)))
    return bucket
  },
})

export const encryptionMiddleware = createEncryptionMiddleware()
