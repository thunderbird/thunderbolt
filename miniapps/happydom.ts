/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A DOM for the guest SDK's tests.
 *
 * The bridge is `window.parent.postMessage` and a `message` listener from top to
 * bottom, so there is nothing to test without one. Kept minimal on purpose: no
 * React harness and no fake timers, because the only thing under test here is
 * the wire.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
