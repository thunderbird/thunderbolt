/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Filesystem locations for the iroh transport's persistent state (identity and
 * peer allowlist). Everything lives under a single per-user home directory,
 * `~/.thunderbolt/iroh/`, overridable via `THUNDERBOLT_HOME` — the override is
 * what lets a second identity be exercised on the same machine (e.g. proving
 * the allowlist gate rejects an unknown peer).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root for all thunderbolt CLI state. `THUNDERBOLT_HOME` overrides the default
 *  `~/.thunderbolt`, enabling isolated identities for testing/multi-account. */
const baseDir = (): string => process.env.THUNDERBOLT_HOME ?? join(homedir(), '.thunderbolt')

/** Directory holding the iroh identity and allowlist. */
export const irohDir = (): string => join(baseDir(), 'iroh')

/** Path to the persisted 32-byte node secret key (hex-encoded, mode 0600). */
export const identityPath = (): string => join(irohDir(), 'identity')

/** Path to the newline-delimited list of allowed peer NodeIds. */
export const allowlistPath = (): string => join(irohDir(), 'allowlist')
