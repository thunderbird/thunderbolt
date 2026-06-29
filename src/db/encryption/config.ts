/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { getCK } from '@/crypto/key-storage'

/** Whether E2E encryption is enabled. Reads from the persisted config store (hydrated from /config endpoint). */
export const isEncryptionEnabled = (): boolean => useConfigStore.getState().config.e2eeEnabled === true

/**
 * Returns true when the sync setup wizard is needed before enabling sync.
 * The wizard is required only when E2EE is enabled AND no Content Key exists yet.
 */
export const needsSyncSetupWizard = async (): Promise<boolean> => {
  if (!isEncryptionEnabled()) {
    return false
  }
  return !(await getCK())
}

/**
 * Single source of truth for encrypted tables and their columns.
 * Uses DB column names (snake_case) — matches both PowerSync sync data and CRUD upload operations.
 *
 * Adding a table here automatically enables:
 * - Download decryption via EncryptionMiddleware (sync pipeline)
 * - Upload encryption via encodeForUpload (connector)
 *
 * Workspace-registry tables: only `workspaces.name` is encrypted. Other columns
 * on workspace tables are server-readable by design:
 * - `workspaces.is_personal` / `owner_user_id` — the BE handler branches on
 *   these to gate personal vs shared writes; encrypting them would break the
 *   policy logic.
 * - `workspace_memberships.role` — the BE upload handlers read it to resolve
 *   per-key permissions (admin satisfies every key by default, Decision 11)
 *   and to enforce the admin-escalation guard on membership/pending writes.
 * - `workspace_memberships.user_name` / `user_email` — written by the BE upload
 *   handler from `auth.user`, so they're inherently server-known. Encrypting
 *   them would also block the Members page from rendering display info.
 * - `workspace_pending_memberships.email` — the Better Auth post-create hook
 *   matches this against the new user's email to promote pending invites into
 *   real memberships. Plaintext is functionally required here.
 * - `workspace_permissions.permission_key` / `required_role` — config policy
 *   the BE handler reads.
 */
export const encryptedColumnsMap: Readonly<Record<string, readonly string[]>> = {
  settings: ['value'],
  workspaces: ['name'],
  chat_threads: ['title'],
  chat_messages: ['content', 'parts', 'cache', 'metadata'],
  tasks: ['item'],
  models: ['name', 'model', 'url', 'vendor', 'description', 'api_key'],
  prompts: ['title', 'prompt'],
  triggers: ['trigger_time'],
  model_profiles: [
    'tools_override',
    'link_previews_override',
    'chat_mode_addendum',
    'search_mode_addendum',
    'research_mode_addendum',
    'citation_reinforcement_prompt',
    'nudge_final_step',
    'nudge_preventive',
    'nudge_retry',
    'nudge_search_final_step',
    'nudge_search_preventive',
    'nudge_search_retry',
    'provider_options',
  ],
  modes: ['name', 'label', 'icon', 'system_prompt'],
  devices: ['name'],
  skills: ['name', 'description', 'instruction'],
}
