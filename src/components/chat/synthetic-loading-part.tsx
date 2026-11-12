/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Loader2 } from 'lucide-react'
import { Trans } from '@lingui/react/macro'

type SyntheticLoadingPartProps = {
  isStreaming?: boolean
}

export const SyntheticLoadingPart = ({ isStreaming }: SyntheticLoadingPartProps) => {
  if (!isStreaming) {
    return null
  }

  return (
    <div
      role="status"
      data-testid="loading-status"
      className="mt-2 flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
      <Trans>Working…</Trans>
    </div>
  )
}
