/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { getAK, listDEKs } from '@/crypto'

/** Whether E2E encryption is enabled. Reads from the persisted config store (hydrated from /config endpoint). */
export const isEncryptionEnabled = (): boolean => useConfigStore.getState().config.e2eeEnabled === true

/**
 * Returns true when the sync setup wizard is needed before enabling sync.
 * The wizard is required only when E2EE is enabled AND the v2 key hierarchy is
 * incomplete — an AK plus at least one wrapped DEK must exist locally.
 *
 * Boolean contract unchanged from v1 ("is encryption set up? → bool"), so the
 * existing consumers need no edit; only the underlying check moved from
 * CK-exists to AK+DEK-exists.
 */
export const needsSyncSetupWizard = async (): Promise<boolean> => {
  if (!isEncryptionEnabled()) {
    return false
  }
  const [ak, wrappedDEKs] = await Promise.all([getAK(), listDEKs()])
  return !ak || wrappedDEKs.length === 0
}

/**
 * Re-exported from `@shared/e2ee-types`, which owns the map so the backend can
 * enforce the same contract on upload. This module remains the frontend's
 * import site: it is the encode-selection authority for the upload encoder.
 * Decode stays prefix-gated (any `__enc:` value), so a stale client still
 * decodes columns it does not know are encrypted.
 */
export { encryptedColumnsMap } from '@shared/e2ee-types'
