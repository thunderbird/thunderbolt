/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getConnectionsOAuthCallback } from './oauth-callback'

describe('getConnectionsOAuthCallback', () => {
  it('ignores router state without an OAuth callback', () => {
    expect(getConnectionsOAuthCallback(null)).toEqual({ kind: 'none' })
    expect(getConnectionsOAuthCallback({ unrelated: true })).toEqual({ kind: 'none' })
  })

  it('routes ordinary provider callbacks to integrations', () => {
    const callback = { code: 'code', state: 'state' }
    expect(getConnectionsOAuthCallback({ oauth: callback })).toEqual({ kind: 'integration', callback })
  })
})
