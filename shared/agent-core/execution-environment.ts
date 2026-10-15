/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ExecutionEnv } from '@earendil-works/pi-agent-core'

/** The environment operations used by the app's coding tools, independent of host. */
export type CodingEnvironment = Pick<
  ExecutionEnv,
  'absolutePath' | 'exec' | 'readBinaryFile' | 'writeFile' | 'createTempFile'
>
