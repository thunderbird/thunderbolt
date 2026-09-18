/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * User-facing groupings for a selective export.
 *
 * The envelope is keyed by table, but tables are not how anyone thinks about
 * their data — and fifteen checkboxes is not a choice, it is a chore. These
 * groups are the unit the picker offers.
 *
 * Two rules shape the membership:
 *
 *  - **A credential rides with what it unlocks.** `mcp_secrets` without
 *    `mcp_servers` is a bag of tokens with nothing to attach them to, and
 *    `mcp_servers` without `mcp_secrets` imports a connection that silently
 *    cannot authenticate. Splitting them would produce a working export that
 *    fails at use, so no group owns half a pair.
 *  - **Every table belongs to exactly one group.** A table in two groups would
 *    be exported twice with no way to reconcile the copies, and a table in none
 *    would vanish from a "select everything" export — which is the default, and
 *    must stay byte-equivalent to the old whole-account backup.
 */

import type { IncludedTableName } from './export'
import { exportedTableNames } from './export'

export type ExportGroupId = 'chats' | 'connections' | 'skillsAgents' | 'models' | 'automation' | 'preferences'

export type ExportGroup = {
  id: ExportGroupId
  /** Tables this group contributes to the envelope. */
  tables: readonly IncludedTableName[]
  /** True when the group carries user-typed credentials, which the picker warns about. */
  containsSecrets: boolean
}

/**
 * Group membership. Labels live in the UI layer, not here — this module is
 * imported by non-React callers and must stay free of i18n macros, which
 * resolve against whatever catalog is active where they are evaluated.
 */
export const exportGroups: readonly ExportGroup[] = Object.freeze([
  { id: 'chats', tables: ['chat_threads', 'chat_messages', 'projects', 'prompts'], containsSecrets: false },
  { id: 'connections', tables: ['mcp_servers', 'mcp_secrets'], containsSecrets: true },
  { id: 'skillsAgents', tables: ['skills', 'agents', 'agents_secrets'], containsSecrets: true },
  { id: 'models', tables: ['models', 'model_profiles', 'models_secrets'], containsSecrets: true },
  { id: 'automation', tables: ['tasks', 'triggers'], containsSecrets: false },
  { id: 'preferences', tables: ['settings'], containsSecrets: false },
] as const satisfies readonly ExportGroup[])

export const allExportGroupIds: readonly ExportGroupId[] = Object.freeze(exportGroups.map((group) => group.id))

/** Resolve a set of group ids to the tables an export should walk. */
export const tablesForGroups = (groupIds: readonly ExportGroupId[]): IncludedTableName[] => {
  const selected = new Set(groupIds)
  return exportGroups.filter((group) => selected.has(group.id)).flatMap((group) => [...group.tables])
}

/**
 * Every exportable table, partitioned exactly once across the groups.
 *
 * Asserted by a test rather than only by review: `includedTables` is derived
 * from the PowerSync schema, so adding a table there silently adds it to
 * exports. Without this check it would land in no group and disappear from
 * selective exports — a data-loss bug in a backup feature, and invisible.
 */
export const groupedTableNames: readonly IncludedTableName[] = Object.freeze(
  exportGroups.flatMap((group) => [...group.tables]),
)

/** Tables present in the schema but claimed by no group. Empty is the invariant. */
export const ungroupedTableNames = (): IncludedTableName[] =>
  exportedTableNames.filter((name) => !groupedTableNames.includes(name))
