/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Desktop Chromium has no software keyboard: fake the visual viewport an open 300 px one leaves, then focus the
// page's first field.
Object.defineProperty(window, 'visualViewport', {
  value: Object.assign(new EventTarget(), {
    width: document.documentElement.clientWidth,
    height: innerHeight - 300,
    offsetLeft: 0,
    offsetTop: 0,
  }),
  configurable: true,
})
document.querySelector('input, textarea').focus()
