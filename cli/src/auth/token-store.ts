/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Versioned persistence and resolution for CLI account credentials. */

import { randomBytes, randomUUID } from 'node:crypto'
import { isCliDeviceId } from '../../../shared/cli-device-id.ts'
import { hasExactKeys, isNonblankString, isRecord, parseJson } from '../lib/json.ts'
import { readFileOrNull, removeSecureFile, withSecureFileLock, writeSecureFile } from '../lib/secure-fs.ts'
import { createStateError } from '../lib/state-error.ts'
import { authConfigPath } from '../paths.ts'
import type { CliAuth, ResolvedAccountCredential, SessionCredential } from '../provider-runtime/types.ts'
import { resolveCloudUrl, resolvePatToken } from './config.ts'

type LegacyCliAuthConfig = {
  readonly token: string
  readonly cloudUrl: string
}

/** Which auth scheme an existing external bridge sends on the wire. */
export type CredentialKind = 'session' | 'apiKey'

/** Compatibility projection consumed by existing bridge transports. */
export type BridgeCredential = {
  readonly token: string
  readonly cloudUrl: string
  readonly kind: CredentialKind
}

type ParsedAuth = { readonly auth: CliAuth; readonly migrated: boolean }

export type AuthStateExpectation =
  | { readonly kind: 'exact'; readonly auth: CliAuth | null }
  | { readonly kind: 'installation'; readonly auth: CliAuth }

export type CompareAndSetAuth = (
  expected: AuthStateExpectation,
  next: CliAuth | null,
  path?: string,
) => Promise<boolean>

const cacheSecretPattern = /^[0-9a-f]{64}$/
const authKeys = ['version', 'backendUrl', 'deviceId', 'userCacheSecret', 'registration', 'bearer'] as const

/** Reconstructs the strict v2 auth schema from untrusted JSON. */
const parseAuthV2 = (value: unknown): CliAuth | null => {
  if (!isRecord(value) || !hasExactKeys(value, authKeys) || value.version !== 2) return null
  if (!isNonblankString(value.backendUrl)) return null
  if (!isCliDeviceId(value.deviceId)) return null
  if (typeof value.userCacheSecret !== 'string' || !cacheSecretPattern.test(value.userCacheSecret)) return null

  const base = {
    version: 2 as const,
    backendUrl: value.backendUrl,
    deviceId: value.deviceId,
    userCacheSecret: value.userCacheSecret,
  }
  if (value.registration === 'authentication-required' && value.bearer === null) {
    return { ...base, registration: 'authentication-required', bearer: null }
  }
  if ((value.registration === 'legacy' || value.registration === 'registered') && isNonblankString(value.bearer)) {
    return { ...base, registration: value.registration, bearer: value.bearer }
  }
  return null
}

/** Reconstructs the historical bearer/backend auth shape. */
const parseLegacyAuth = (value: unknown): LegacyCliAuthConfig | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['token', 'cloudUrl'])) return null
  if (!isNonblankString(value.token) || !isNonblankString(value.cloudUrl)) return null
  return { token: value.token, cloudUrl: value.cloudUrl }
}

/** Creates installation metadata for a historical web-session bearer. */
const migrateLegacyAuth = (legacy: LegacyCliAuthConfig): CliAuth => ({
  version: 2,
  backendUrl: legacy.cloudUrl,
  deviceId: `cli-${randomUUID()}`,
  userCacheSecret: randomBytes(32).toString('hex'),
  registration: 'legacy',
  bearer: legacy.token,
})

/** Converts a session credential into canonical persisted auth state. */
export const toAuth = (
  credential: SessionCredential,
  registration: 'registered' | 'authentication-required',
): CliAuth => ({
  version: 2,
  backendUrl: credential.backendUrl,
  deviceId: credential.deviceId,
  userCacheSecret: Buffer.from(credential.userCacheSecret).toString('hex'),
  ...(registration === 'registered' ? { registration, bearer: credential.bearer } : { registration, bearer: null }),
})

/** Matches exact auth or any bearer owned by the same installation. */
const authMatchesExpectation = (current: CliAuth | null, expected: AuthStateExpectation): boolean => {
  if (expected.kind === 'exact') {
    return (
      JSON.stringify(current === null ? null : parseAuthV2(current)) ===
      JSON.stringify(expected.auth === null ? null : parseAuthV2(expected.auth))
    )
  }
  if (current === null) return false
  return (
    current.backendUrl === expected.auth.backendUrl &&
    current.deviceId === expected.auth.deviceId &&
    current.userCacheSecret === expected.auth.userCacheSecret
  )
}

/** Parses JSON and differentiates invalid schemas from unsupported versions. */
const parseStoredAuth = (contents: string, path: string): ParsedAuth => {
  const parsed = parseJson(contents, createStateError('auth config', 'config-invalid', path))

  if (isRecord(parsed) && typeof parsed.version === 'number' && parsed.version !== 2) {
    throw createStateError('auth config', 'config-version-unsupported', path)
  }
  const current = parseAuthV2(parsed)
  if (current !== null) return { auth: current, migrated: false }
  const legacy = parseLegacyAuth(parsed)
  if (legacy !== null) return { auth: migrateLegacyAuth(legacy), migrated: true }
  throw createStateError('auth config', 'config-invalid', path)
}

/** Loads canonical state while already holding the per-path auth mutation lane. */
const loadAuthConfigUnlocked = async (path: string): Promise<CliAuth | null> => {
  const contents = await readFileOrNull(path)
  if (contents === null) return null

  const parsed = parseStoredAuth(contents, path)
  if (parsed.migrated) {
    await writeSecureFile(path, `${JSON.stringify(parsed.auth, null, 2)}\n`)
  }
  return parsed.auth
}

/** Loads v2 auth state and singleflights historical bearer migration per durable path. */
export const loadAuthConfig = (path: string = authConfigPath()): Promise<CliAuth | null> =>
  withSecureFileLock(path, () => loadAuthConfigUnlocked(path))

/** Persists only frozen v2 auth state. */
export const storeAuthConfig = (auth: CliAuth, path: string = authConfigPath()): Promise<void> => {
  const canonical = parseAuthV2(auth)
  if (canonical === null) throw createStateError('auth config', 'config-invalid', path)
  return withSecureFileLock(path, () => writeSecureFile(path, `${JSON.stringify(canonical, null, 2)}\n`))
}

/** Conditionally replaces durable auth while holding the same lane as stores, clears, and migration. */
export const compareAndSetAuthConfig = (
  expected: AuthStateExpectation,
  next: CliAuth | null,
  path: string = authConfigPath(),
): Promise<boolean> =>
  withSecureFileLock(path, async () => {
    const current = await loadAuthConfigUnlocked(path)
    if (!authMatchesExpectation(current, expected)) return false

    if (next === null) {
      await removeSecureFile(path)
      return true
    }
    const canonical = parseAuthV2(next)
    if (canonical === null) throw createStateError('auth config', 'config-invalid', path)
    await writeSecureFile(path, `${JSON.stringify(canonical, null, 2)}\n`)
    return true
  })

/** Clears the entire stored installation without following symlinks. */
export const clearAuthConfig = (path: string = authConfigPath()): Promise<void> =>
  withSecureFileLock(path, () => removeSecureFile(path))

/**
 * Resolves the effective managed-inference credential. Environment PATs have
 * absolute precedence and intentionally avoid reading stored session state.
 */
export const resolveAccountCredential = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedAccountCredential | null> => {
  const patToken = resolvePatToken(env)
  if (patToken) return { type: 'pat', backendUrl: resolveCloudUrl(env), token: patToken }

  const stored = await loadAuthConfig(authConfigPath(env))
  if (stored === null || stored.registration === 'authentication-required') return null
  return {
    type: 'session',
    backendUrl: stored.backendUrl,
    bearer: stored.bearer,
    deviceId: stored.deviceId,
    userCacheSecret: Uint8Array.from(Buffer.from(stored.userCacheSecret, 'hex')),
  }
}

/**
 * Preserves the existing bridge contract while ignoring device and Tinfoil
 * metadata introduced by account installations.
 */
export const resolveBridgeCredential = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BridgeCredential | null> => {
  const credential = await resolveAccountCredential(env)
  if (credential === null) return null
  if (credential.type === 'pat') {
    return { token: credential.token, cloudUrl: credential.backendUrl, kind: 'apiKey' }
  }
  return { token: credential.bearer, cloudUrl: credential.backendUrl, kind: 'session' }
}
