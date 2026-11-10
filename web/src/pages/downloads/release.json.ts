/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getReleaseSnapshot } from '../../server/release-snapshot'

// nginx serves the live shared cache at this URL; this generated file is its offline fallback.
export const GET = async () => Response.json(await getReleaseSnapshot())
