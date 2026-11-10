/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v5 as uuidv5 } from 'uuid'
/** Same identity inline and in the panel, independent of provider-specific tool-call syntax. */
export const artifactPageId = (toolCallId: string) =>
  `artifact-${uuidv5(toolCallId, '06a20220-793c-42dc-a840-45dfbd5ea1f4')}`
