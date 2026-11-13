/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getReleaseSnapshot } from '../../server/release-snapshot'

// The release this build embeds, in the form GitHub describes it. The marketing nginx answers
// this URL with GitHub's current release and falls back to this file; other hosts serve it as is.
export const GET = async () => Response.json((await getReleaseSnapshot()).raw)
