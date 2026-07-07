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
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { enforceSecureFile, readFileOrNull, writeSecureFile } from '../iroh/storage.ts'

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
