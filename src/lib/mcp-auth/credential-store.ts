import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { mcpServersTable } from '@/db/tables'
import type { CredentialStore, McpCredential } from '@/types/mcp'

/** Application-specific salt prefix mixed with the device hostname */
const APP_SALT_PREFIX = 'thunderbolt-mcp-v1:'

/** PBKDF2 iteration count — must be >= 100,000 per security requirements */
const PBKDF2_ITERATIONS = 100_000

/** Encrypts a credential using AES-GCM with a derived key */
type EncryptedBlob = {
  iv: string
  ciphertext: string
}

/**
 * Derives a 256-bit AES-GCM key from the device hostname using PBKDF2.
 * The key is bound to the hostname so credentials are device-local.
 */
const deriveKey = async (hostname: string): Promise<CryptoKey> => {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(APP_SALT_PREFIX + hostname),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode('thunderbolt-mcp-credential-salt'),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypts a JSON-serializable value using AES-GCM.
 * Each call generates a unique random IV, so identical inputs produce different ciphertexts.
 */
const encrypt = async (key: CryptoKey, plaintext: string): Promise<string> => {
  const encoder = new TextEncoder()
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  )

  const blob: EncryptedBlob = {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  }
  return JSON.stringify(blob)
}

/**
 * Decrypts a value previously encrypted with `encrypt`.
 */
const decrypt = async (key: CryptoKey, encryptedJson: string): Promise<string> => {
  const blob: EncryptedBlob = JSON.parse(encryptedJson)
  const iv = Uint8Array.from(atob(blob.iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(blob.ciphertext), (c) => c.charCodeAt(0))

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

/**
 * Retrieves the device hostname for key derivation.
 * Falls back to a static identifier when running outside Tauri (e.g., in tests).
 */
const getHostname = async (): Promise<string> => {
  try {
    const { hostname } = await import('@tauri-apps/plugin-os')
    return await hostname()
  } catch {
    return 'thunderbolt-local'
  }
}

/** Lazily-derived key, cached after first derivation within a session */
let cachedKey: CryptoKey | null = null

const getEncryptionKey = async (): Promise<CryptoKey> => {
  if (cachedKey) return cachedKey
  const host = await getHostname()
  cachedKey = await deriveKey(host)
  return cachedKey
}

/**
 * Creates an encrypted credential store that persists credentials
 * in the `mcp_servers.encrypted_credential` column using AES-GCM encryption.
 *
 * Key derivation: PBKDF2(APP_SALT_PREFIX + hostname) -> 256-bit AES-GCM key.
 * Storage format: `{ iv: base64, ciphertext: base64 }` serialized as JSON.
 *
 * Credentials are never stored in plaintext — only the encrypted blob reaches SQLite.
 */
const createCredentialStore = (db: AnyDrizzleDatabase): CredentialStore => {
  const save = async (serverId: string, credential: McpCredential): Promise<void> => {
    const key = await getEncryptionKey()
    const encryptedCredential = await encrypt(key, JSON.stringify(credential))
    await db
      .update(mcpServersTable)
      .set({ encryptedCredential })
      .where(eq(mcpServersTable.id, serverId))
  }

  const load = async (serverId: string): Promise<McpCredential | null> => {
    const rows = await db
      .select({ encryptedCredential: mcpServersTable.encryptedCredential })
      .from(mcpServersTable)
      .where(eq(mcpServersTable.id, serverId))

    const row = rows[0]
    if (!row?.encryptedCredential) return null

    const key = await getEncryptionKey()
    const plaintext = await decrypt(key, row.encryptedCredential)
    return JSON.parse(plaintext) as McpCredential
  }

  const deleteCredential = async (serverId: string): Promise<void> => {
    await db
      .update(mcpServersTable)
      .set({ encryptedCredential: null })
      .where(eq(mcpServersTable.id, serverId))
  }

  return { save, load, delete: deleteCredential }
}

export { createCredentialStore }
/** Exported for testing only — resets the in-memory key cache */
export const resetKeyCache = () => {
  cachedKey = null
}
