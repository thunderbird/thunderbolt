/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Window } from 'happy-dom'

// Must run before the app stores are imported: Zustand binds its storage at import time.
// Preserve Bun's native fetch; a full DOM registration buffers confidential SSE streams.
const window = new Window()
Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage })
