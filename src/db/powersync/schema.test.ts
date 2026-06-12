/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { powersyncTableNames } from '@shared/powersync-tables'
import { drizzleSchema } from './schema'

/**
 * MCP server config and its credentials are per-device local-only: syncing the server
 * entry without its (local-only) credentials would replicate a non-functional server to
 * other devices. These guards fail if mcp_servers is ever re-added to the synced set.
 */
describe('MCP tables are local-only (not synced)', () => {
  it('are absent from the synced table list', () => {
    expect(powersyncTableNames).not.toContain('mcp_servers')
    expect(powersyncTableNames).not.toContain('mcp_secrets')
  })

  it('are registered as local-only in the PowerSync schema', () => {
    // Local-only entries are { tableDefinition, options: { localOnly: true } };
    // synced entries are bare Drizzle table objects without `options`.
    const localOnlyOption = (entry: unknown) => (entry as { options?: { localOnly?: boolean } }).options?.localOnly

    expect(localOnlyOption(drizzleSchema.mcp_servers)).toBe(true)
    expect(localOnlyOption(drizzleSchema.mcp_secrets)).toBe(true)
  })
})
