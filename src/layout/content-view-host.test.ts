/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { routeHostsContentView } from './content-view-host'

describe('routeHostsContentView', () => {
  it('is the Mini App route, which layers the view over its own chat pane', () => {
    expect(routeHostsContentView('/apps/finance-model')).toBeTrue()
    expect(routeHostsContentView('/apps/finance-model?chat=abc')).toBeTrue()
  })

  it('leaves every other route to main-layout', () => {
    expect(routeHostsContentView('/chats/abc')).toBeFalse()
    expect(routeHostsContentView('/settings/preferences')).toBeFalse()
    expect(routeHostsContentView('/')).toBeFalse()
  })
})
