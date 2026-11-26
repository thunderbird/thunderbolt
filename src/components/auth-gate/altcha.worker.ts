/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '../../lib/install-webkit-own-property'

// altcha-lib's v1 worker installs its own message handler; this file only gives Vite an entry to bundle.
import 'altcha-lib/v1/worker'
