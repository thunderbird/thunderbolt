/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Bug } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

import { Button } from '@/components/ui/button'

type ShareDebugTranscriptButtonProps = {
  disabledReason: string | null
  onShare: () => void
}

export const ShareDebugTranscriptButton = ({ disabledReason, onShare }: ShareDebugTranscriptButtonProps) => {
  const { t } = useLingui()
  const actionLabel = t`Share debug transcript`

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 rounded-lg"
      title={disabledReason ?? actionLabel}
      aria-label={actionLabel}
      disabled={disabledReason !== null}
      onClick={onShare}
    >
      <Bug className="size-4 text-muted-foreground/80" />
    </Button>
  )
}
