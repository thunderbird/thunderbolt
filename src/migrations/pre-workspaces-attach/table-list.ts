/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Canonical list of legacy `thunderbolt-sync.db` tables to copy into the new
 * `server-<id>.db` during the Workspaces v1 upgrade. `needsWorkspaceId` adds
 * `workspace_id = personalWorkspaceId` to each row at insert time;
 * `needsScope` additionally stamps `scope = 'workspace'`.
 *
 * The new Workspaces v1 tables (`workspaces`, `workspace_memberships`,
 * `workspace_pending_memberships`, `workspace_permissions`) are NOT listed —
 * they don't exist in the legacy schema. The personal workspace itself is
 * created by `ensurePersonalWorkspace` before this migration runs.
 */
export type LegacyTable = {
  readonly name: string
  readonly needsWorkspaceId: boolean
  readonly needsScope: boolean
}

export const syncedLegacyTables: readonly LegacyTable[] = [
  { name: 'chat_threads', needsWorkspaceId: true, needsScope: false },
  { name: 'chat_messages', needsWorkspaceId: true, needsScope: false },
  { name: 'tasks', needsWorkspaceId: true, needsScope: false },
  { name: 'models', needsWorkspaceId: true, needsScope: true },
  { name: 'prompts', needsWorkspaceId: true, needsScope: true },
  { name: 'skills', needsWorkspaceId: true, needsScope: true },
  { name: 'triggers', needsWorkspaceId: true, needsScope: true },
  { name: 'modes', needsWorkspaceId: true, needsScope: true },
  { name: 'model_profiles', needsWorkspaceId: true, needsScope: true },
  { name: 'agents', needsWorkspaceId: true, needsScope: true },
  { name: 'settings', needsWorkspaceId: false, needsScope: false },
  { name: 'devices', needsWorkspaceId: false, needsScope: false },
]

export const localLegacyTables: readonly LegacyTable[] = [
  { name: 'mcp_servers', needsWorkspaceId: true, needsScope: false },
  // models_secrets is intentionally absent: its api_key value is folded into
  // models.api_key by the local-db-migration (THU-579 reverts THU-505).
  { name: 'integrations_secrets', needsWorkspaceId: false, needsScope: false },
  { name: 'mcp_secrets', needsWorkspaceId: false, needsScope: false },
  { name: 'agents_secrets', needsWorkspaceId: false, needsScope: false },
  { name: 'agents_system', needsWorkspaceId: false, needsScope: false },
]

export const allLegacyTables: readonly LegacyTable[] = [...syncedLegacyTables, ...localLegacyTables]
