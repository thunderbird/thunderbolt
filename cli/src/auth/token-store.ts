/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Persistence for the CLI's account credential: the signed bearer minted by the
 * device grant plus the cloud URL it belongs to, stored as owner-only JSON at
 * `~/.thunderbolt/auth.json` (mode 0600). Reuses the secure filesystem helpers
 * that back the iroh identity/allowlist stores so the credential gets the same
 * `0600`-in-`0700` treatment. Honors `THUNDERBOLT_HOME` for isolated test/multi
 * account homes, matching `iroh/paths.ts`.
 *
 * Also resolves the *effective* credential a running bridge authenticates with
 * ({@link resolveBridgeCredential}): the env PAT (a Better Auth api key, the
 * zero-human CI / self-host escape hatch) takes precedence over the stored login,
 * and each carries a {@link CredentialKind} so the caller sends the right wire
 * header (`x-api-key` for api keys, `Authorization: Bearer` for device sessions).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { enforceSecureFile, readFileOrNull, writeSecureFile } from '../lib/secure-fs.ts'
import { resolveCloudUrl, resolvePatToken } from './config.ts'

/** Root for all thunderbolt CLI state; `THUNDERBOLT_HOME` overrides the default. */
const baseDir = (): string => process.env.THUNDERBOLT_HOME ?? join(homedir(), '.thunderbolt')

/** Path to the persisted CLI auth config. */
const authConfigPath = (): string => join(baseDir(), 'auth.json')

/** The persisted CLI credential: a signed bearer bound to a specific backend. */
export type CliAuthConfig = {
  readonly token: string
  readonly cloudUrl: string
}

/**
 * Load the stored credential, or `null` when the CLI has never logged in.
 *
 * @returns the persisted {@link CliAuthConfig}, or `null` if absent
 */
export const loadAuthConfig = async (): Promise<CliAuthConfig | null> => {
  const path = authConfigPath()
  const raw = await readFileOrNull(path)
  if (raw === null) return null
  // Force 0600 on read so a credential restored/copied with lax permissions
  // self-heals — mirrors the iroh identity loader.
  await enforceSecureFile(path)
  return JSON.parse(raw) as CliAuthConfig
}

/**
 * Persist the credential owner-only (0600), replacing any prior login.
 *
 * @param config - the credential to store
 */
export const storeAuthConfig = async (config: CliAuthConfig): Promise<void> => {
  await writeSecureFile(baseDir(), authConfigPath(), `${JSON.stringify(config, null, 2)}\n`)
}

/** Which auth scheme a credential presents on the wire: an interactive device-grant
 *  session (`Authorization: Bearer`) or a Better Auth api key / PAT (`x-api-key` —
 *  the apiKey plugin authenticates ONLY via that header, never the bearer one). */
export type CredentialKind = 'session' | 'apiKey'

/** The effective credential a running bridge authenticates with: the token, the
 *  backend it belongs to, and the wire scheme. Resolved from the env PAT (CI /
 *  self-host) or the stored device-grant login. */
export type BridgeCredential = {
  readonly token: string
  readonly cloudUrl: string
  readonly kind: CredentialKind
}

/**
 * Resolve the credential a running bridge should authenticate with. The env PAT
 * (`THUNDERBOLT_TOKEN`, a Better Auth api key) wins as the zero-human CI / self-host
 * escape hatch — it authenticates via `x-api-key` against the cloud URL from the env
 * (`THUNDERBOLT_CLOUD_URL`, or the default). Otherwise the stored device-grant login
 * is used as a session bearer. Returns `null` in Standalone / no-credential mode,
 * where the bridge falls back to the manual `iroh allow` file.
 *
 * @returns the effective {@link BridgeCredential}, or `null` when none is configured
 */
export const resolveBridgeCredential = async (): Promise<BridgeCredential | null> => {
  const patToken = resolvePatToken()
  if (patToken) return { token: patToken, cloudUrl: resolveCloudUrl(), kind: 'apiKey' }
  const stored = await loadAuthConfig()
  if (!stored) return null
  return { token: stored.token, cloudUrl: stored.cloudUrl, kind: 'session' }
}
