/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { exportedTableNames } from './export'
import {
  allExportGroupIds,
  exportGroups,
  groupedTableNames,
  tablesForGroups,
  ungroupedTableNames,
} from './export-groups'

describe('export groups', () => {
  it('claims every exportable table exactly once', () => {
    // The guard that matters. `includedTables` is derived from the PowerSync
    // schema, so a new table there joins exports automatically — but it would
    // belong to no group and silently never appear in a selective export.
    // Failing here tells whoever added it to pick a group.
    expect(ungroupedTableNames()).toEqual([])

    const seen = new Set<string>()
    for (const name of groupedTableNames) {
      expect(seen.has(name)).toBe(false)
      seen.add(name)
    }
    expect(seen.size).toBe(exportedTableNames.length)
  })

  it('selecting every group covers the full export', () => {
    expect(tablesForGroups(allExportGroupIds).sort()).toEqual([...exportedTableNames].sort())
  })

  it('selecting no group yields no tables', () => {
    expect(tablesForGroups([])).toEqual([])
  })

  it('keeps each credential table with the rows it unlocks', () => {
    // A secret without its parent imports a token attached to nothing; a parent
    // without its secret imports a connection that cannot authenticate. Neither
    // is a useful export, so the pairs must never be split across groups.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['mcp_servers', 'mcp_secrets'],
      ['models', 'models_secrets'],
      ['agents', 'agents_secrets'],
    ]
    for (const [parent, secret] of pairs) {
      const owner = exportGroups.find((group) => (group.tables as readonly string[]).includes(parent))
      expect(owner).toBeDefined()
      expect(owner?.tables as readonly string[]).toContain(secret)
    }
  })

  it('flags exactly the groups that carry credentials', () => {
    for (const group of exportGroups) {
      const hasSecretTable = group.tables.some((name) => name.endsWith('_secrets'))
      expect(group.containsSecrets).toBe(hasSecretTable)
    }
  })

  it('ignores unknown group ids rather than throwing', () => {
    // The picker persists selections; a group renamed in a later build must not
    // make a stored selection unloadable.
    expect(tablesForGroups(['connections', 'nope' as never])).toEqual(['mcp_servers', 'mcp_secrets'])
  })
})
