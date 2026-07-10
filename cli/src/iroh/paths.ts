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

import { join } from 'node:path'
import type { BridgeProtocol } from '../agent/types.ts'
import { thunderboltHomeDir } from '../paths.ts'

/** Directory holding the iroh identity and allowlist. */
export const irohDir = (): string => join(thunderboltHomeDir(), 'iroh')

/** Path to a protocol's persisted 32-byte node secret key (hex-encoded, mode
 *  0600). Each bridge protocol gets a distinct NodeId by loading a distinct
 *  file, so an ACP ticket can never authenticate the MCP bridge (or vice-versa)
 *  when a stale address resolves the wrong process. `acp` keeps the legacy
 *  `identity` filename so every existing ACP pairing survives untouched. */
export const identityPath = (protocol: BridgeProtocol): string =>
  join(irohDir(), protocol === 'acp' ? 'identity' : `identity-${protocol}`)

/** Path to the newline-delimited list of allowed peer NodeIds. */
export const allowlistPath = (): string => join(irohDir(), 'allowlist')
