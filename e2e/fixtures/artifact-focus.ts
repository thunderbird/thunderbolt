/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { subscribeToIframeFocus } from '../../src/artifacts/iframe-focus'

const status = document.getElementById('focused')!
const unsubscribe = subscribeToIframeFocus((frame) => {
  status.textContent = frame?.id ?? 'none'
})
document.getElementById('unsubscribe')!.addEventListener('click', unsubscribe)
