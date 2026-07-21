/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RegistryEntry } from '@/types/registry'

/**
 * Builds the shell command that runs an ACP agent from its registry
 * distribution, or `null` when the entry has no npx/uvx distribution. Binary
 * commands are excluded because registry commands are post-archive-extraction
 * paths rather than standalone setup commands; those agents require authored
 * metadata.
 *
 * @param entry - The registry entry to derive the command from.
 */
export const buildRunCommand = (entry: RegistryEntry): string | null => {
  const { npx, uvx } = entry.distribution
  if (npx) {
    return ['npx', '-y', npx.package, ...(npx.args ?? [])].join(' ')
  }
  if (uvx) {
    return ['uvx', uvx.package, ...(uvx.args ?? [])].join(' ')
  }
  return null
}
