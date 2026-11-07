/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createServer } from 'vite'
import { isolatedFrontendConfig } from './frontend-config'

if (import.meta.main) {
  await (await createServer(isolatedFrontendConfig({}, Number(process.env.PORT)))).listen()
}
