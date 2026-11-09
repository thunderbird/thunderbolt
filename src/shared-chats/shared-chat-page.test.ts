/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ShareContentInvalidError, ShareGoneError, ShareUnreadableError } from '@/services/shares'
import { describe, expect, it } from 'bun:test'
import { unavailableReason } from './shared-chat-page'

describe('unavailableReason', () => {
  it.each([
    [new ShareGoneError(), 'gone'],
    [new ShareUnreadableError(), 'unreadable'],
    [new ShareContentInvalidError(), 'invalid'],
    [new TypeError('fetch failed'), 'failed'],
  ] as const)('maps %s to %s', (error, reason) => {
    expect(unavailableReason(error)).toBe(reason)
  })
})
