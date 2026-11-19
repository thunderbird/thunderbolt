/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { i18n } from '@/i18n'
import { EncryptionRequestTimeoutError } from '@/services/encryption-request'
import { EncryptedSyncUnsupportedError, encryptedSyncUpgradeMessage } from './encrypted-sync-support'

const requestTimeoutMessage = msg`The server took too long to respond. Please try again.`

/** Resolve known encryption failures at the UI boundary using the current locale. */
export const getEncryptionErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof EncryptionRequestTimeoutError) {
    return i18n._(requestTimeoutMessage)
  }
  if (error instanceof EncryptedSyncUnsupportedError) {
    return i18n._(encryptedSyncUpgradeMessage)
  }
  return error instanceof Error ? error.message : fallback
}
