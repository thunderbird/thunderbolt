/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { bundleMigrations } from '../src/db/bundle-migrations'

bundleMigrations().then((count) => {
  console.log(`Bundled ${count} migrations`)
})