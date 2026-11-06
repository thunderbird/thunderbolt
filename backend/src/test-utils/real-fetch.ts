/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The unmocked fetch `test-setup.ts` keeps aside, for tests that talk to a server they started themselves. */
export const realFetch = (globalThis as typeof globalThis & { __originalFetch: typeof fetch }).__originalFetch
