/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { asStringArray, isRecord } from '@/lib/agent-registry-filter'
import type { RegistryEntry } from '@/types/registry'

/** Maps a runtime platform to the prefix the registry uses on its per-platform
 *  binary keys (e.g. macOS → "darwin", matching "darwin-aarch64"). Returns null on
 *  platforms the registry never targets (web/mobile), where no key can match. */
const binaryKeyPrefix = (platform: string): string | null => {
  switch (platform) {
    case 'macos':
      return 'darwin'
    case 'windows':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      return null
  }
}

/** Picks the binary target for `platform`, preferring a key that matches the
 *  platform prefix and otherwise falling back to the first listed target so
 *  browsing on web/mobile still surfaces a representative command. */
const selectBinaryTarget = (binary: Record<string, unknown>, platform: string): Record<string, unknown> | null => {
  const keys = Object.keys(binary)
  if (keys.length === 0) {
    return null
  }
  const prefix = binaryKeyPrefix(platform)
  const key = prefix ? (keys.find((k) => k.startsWith(prefix)) ?? keys[0]) : keys[0]
  const target = binary[key]
  return isRecord(target) ? target : null
}

/**
 * Builds the shell command that runs an ACP agent from its registry
 * distribution, or `null` when the entry ships no runnable distribution. Prefers
 * npx > uvx > binary, matching the card's distribution badge: `npx`/`uvx` agents
 * produce a self-contained one-liner, while a `binary` agent resolves to the
 * downloaded binary's invocation for `platform` (falling back to the first listed
 * target when the platform isn't one the registry builds for).
 *
 * @param entry - The registry entry to derive the command from.
 * @param platform - The runtime platform (`getPlatform()`), used only for binary
 *   target selection; ignored for npx/uvx.
 */
export const buildRunCommand = (entry: RegistryEntry, platform: string): string | null => {
  const { npx, uvx, binary } = entry.distribution
  if (npx) {
    return ['npx', '-y', npx.package, ...(npx.args ?? [])].join(' ')
  }
  if (uvx) {
    return ['uvx', uvx.package, ...(uvx.args ?? [])].join(' ')
  }
  if (binary) {
    const target = selectBinaryTarget(binary, platform)
    if (!target || typeof target.cmd !== 'string') {
      return null
    }
    return [target.cmd, ...asStringArray(target.args)].join(' ')
  }
  return null
}
