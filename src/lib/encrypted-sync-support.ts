/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { supportsKeyStoreLock } from '@/crypto/key-store-lock'

export const encryptedSyncUpgradeMessage = msg`To use encrypted sync, open this app over HTTPS and use an up-to-date browser or operating system.`

/** The runtime cannot provide exclusive account-key ownership across tabs. */
export class EncryptedSyncUnsupportedError extends Error {
  constructor() {
    super('Encrypted sync requires Web Locks in a secure context')
    this.name = 'EncryptedSyncUnsupportedError'
  }
}

/** Refuse encrypted-sync work unless every tab can coordinate access to account keys. */
export const requireEncryptedSyncSupport = (): void => {
  if (!supportsKeyStoreLock()) {
    throw new EncryptedSyncUnsupportedError()
  }
}
