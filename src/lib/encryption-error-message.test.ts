/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { i18n } from '@/i18n'
import { EncryptionRequestTimeoutError } from '@/services/encryption-request'
import { EncryptedSyncUnsupportedError } from './encrypted-sync-support'
import { getEncryptionErrorMessage } from './encryption-error-message'

describe('encryption error display', () => {
  it('resolves timeout and unsupported-runtime messages in the locale active at display time', () => {
    const previous = { locale: i18n.locale, messages: i18n.messages }
    try {
      i18n.loadAndActivate({
        locale: 'de-x-crypto',
        messages: {
          'The server took too long to respond. Please try again.':
            'Der Server antwortet nicht. Bitte erneut versuchen.',
          'To use encrypted sync, open this app over HTTPS and use an up-to-date browser or operating system.':
            'HTTPS und einen aktuellen Browser verwenden.',
        },
      })
      expect(getEncryptionErrorMessage(new EncryptionRequestTimeoutError(), 'fallback')).toBe(
        'Der Server antwortet nicht. Bitte erneut versuchen.',
      )
      expect(getEncryptionErrorMessage(new EncryptedSyncUnsupportedError(), 'fallback')).toBe(
        'HTTPS und einen aktuellen Browser verwenden.',
      )
    } finally {
      i18n.loadAndActivate(previous)
    }
  })

  it('preserves existing diagnostic messages and caller fallbacks', () => {
    expect(getEncryptionErrorMessage(new Error('existing diagnostic'), 'fallback')).toBe('existing diagnostic')
    expect(getEncryptionErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
