/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { routeHostsContentView } from './content-view-host'

describe('routeHostsContentView', () => {
  it('is the expanded page route', () => {
    expect(routeHostsContentView('/pages/html-one')).toBeTrue()
  })

  it('leaves chat and settings routes to the persistent content-view layout', () => {
    expect(routeHostsContentView('/chats/abc')).toBeFalse()
    expect(routeHostsContentView('/apps/retired-app')).toBeFalse()
    expect(routeHostsContentView('/settings/preferences')).toBeFalse()
    expect(routeHostsContentView('/')).toBeFalse()
  })
})
