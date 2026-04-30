/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Lock } from 'lucide-react'
import TimelineMessage from './timeline-message'
import { memo } from 'react'

export const EncryptionMessage = memo(() => (
  <TimelineMessage>
    <div className="flex flex-row items-center gap-2">
      <Lock className="size-4 text-green-600 dark:text-green-500" />
      <p className="text-green-600 dark:text-green-500">This conversation is confidential</p>
    </div>
  </TimelineMessage>
))
