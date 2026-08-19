/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAK, listDEKs } from '@/crypto'

/**
 * Returns true when the sync setup wizard is needed before enabling sync: the
 * v2 key hierarchy is incomplete — an AK plus at least one wrapped DEK must
 * exist locally.
 */
export const needsSyncSetupWizard = async (): Promise<boolean> => {
  const [ak, wrappedDEKs] = await Promise.all([getAK(), listDEKs()])
  return !ak || wrappedDEKs.length === 0
}

/**
 * Single source of truth for encrypted tables and their columns.
 * Uses DB column names (snake_case) — matches both PowerSync sync data and CRUD upload operations.
 *
 * This map is the encode-selection authority (upload encoder). Decode stays
 * prefix-gated (any `__enc:` value), so a stale client still decodes columns it
 * does not know are encrypted.
 *
 * Adding a table here automatically enables:
 * - Download decryption via EncryptionMiddleware (sync pipeline)
 * - Upload encryption via encodeForUpload (connector)
 */
export const encryptedColumnsMap: Readonly<Record<string, readonly string[]>> = {
  settings: ['value'],
  chat_threads: ['title'],
  chat_messages: ['content', 'parts', 'cache', 'metadata'],
  tasks: ['item'],
  models: ['name', 'model', 'url', 'vendor', 'description'],
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
  devices: ['name'],
  skills: ['name', 'label', 'description', 'instruction'],
}
