/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { parseRegistryJson } from '@/lib/agent-registry-filter'
import type { RegistryEntry } from '@/types/registry'
import snapshot from './acp-registry-snapshot.json'

/**
 * Bundled snapshot of the official ACP registry
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json),
 * parsed into typed entries. Shipped so the catalogue renders instantly and
 * works offline; the live CDN fetch (see `useAgentRegistry`) refreshes it in the
 * background and falls back here on any error.
 */
export const agentRegistrySnapshot: ReadonlyArray<RegistryEntry> = parseRegistryJson(snapshot)
