/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildClientIdentityBlock } from './client-identity'

describe('buildClientIdentityBlock', () => {
  it("omits Bun's stringified undefined app version", () => {
    expect(buildClientIdentityBlock({ environment: 'web', appVersion: 'undefined' })).toBe('Client environment: web')
  })
})
