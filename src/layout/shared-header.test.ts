/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Two callers read this — the layout to decide whether to draw the header, the
 * app route to decide whether to inset for it — so the cases that matter are
 * the ones where they could disagree.
 */

import { describe, expect, it } from 'bun:test'

import { sharedHeaderHasControls } from './shared-header'

const onWeb = { isMobile: false, isDesktopApp: false }
const inDesktopApp = { isMobile: false, isDesktopApp: true }

describe('sharedHeaderHasControls', () => {
  it('keeps the header on ordinary routes', () => {
    expect(sharedHeaderHasControls({ pathname: '/chats/abc', ...onWeb })).toBe(true)
    expect(sharedHeaderHasControls({ pathname: '/settings/models', ...onWeb })).toBe(true)
  })

  /**
   * The bar that prompted this: on an app route the header's own content is all
   * gated on `/chats`, so on web there is nothing in it — just height and a
   * scrim over an app that then cannot reach the top of the window.
   */
  it('drops the empty bar over an app on web', () => {
    expect(sharedHeaderHasControls({ pathname: '/apps/finance-model', ...onWeb })).toBe(false)
  })

  /** In the desktop app it still carries back/forward — and, on a frameless
   *  window, the only drag surface this route has. */
  it('keeps it over an app in the desktop app', () => {
    expect(sharedHeaderHasControls({ pathname: '/apps/finance-model', ...inDesktopApp })).toBe(true)
  })

  /** The mobile header is a different layout and always has the sidebar
   *  toggle, so it is never the empty case. */
  it('keeps it on mobile regardless', () => {
    expect(sharedHeaderHasControls({ pathname: '/apps/finance-model', isMobile: true, isDesktopApp: false })).toBe(true)
  })

  /** Only the app route is special; a path that merely mentions apps is not. */
  it('is not fooled by a path that only looks like an app route', () => {
    expect(sharedHeaderHasControls({ pathname: '/settings/apps', ...onWeb })).toBe(true)
  })
})
