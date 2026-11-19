/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const serverValue = () => undefined

/**
 * Read a value that only the visitor's browser knows. It is `undefined` in the server-rendered
 * page and until that page has hydrated, so both render the same markup.
 */
export const useBrowserValue = <Value>(read: () => Value) => useSyncExternalStore(subscribe, read, serverValue)
