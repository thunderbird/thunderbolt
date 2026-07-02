/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react'
import { Expandable } from '../ui/expandable'

type SyntheticLoadingPartProps = {
  message?: string
  isStreaming?: boolean
}

export const SyntheticLoadingPart = ({ message = '', isStreaming }: SyntheticLoadingPartProps) => {
  if (!isStreaming) {
    return null
  }

  const displayMessage = message && message.trim().length > 0 ? message : '\u00A0'

  const titleNode = <span className="text-sm text-secondary-foreground">{displayMessage}</span>

  return (
    <Expandable
      title={titleNode}
      defaultOpen={false}
      icon={<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      className="shadow-none pointer-events-none mt-6" // Prevent clicking while loading
    >
      {null}
    </Expandable>
  )
}
