/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Bug } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { buttonVariants, mutedIconButtonClass } from '@/components/ui/button'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const actionLabel = 'Share debug transcript'
const touchReasonDurationMs = 3_000

type ShareDebugTranscriptButtonProps = {
  disabledReason: string | null
  onShare: () => void
}

export const ShareDebugTranscriptButton = ({ disabledReason, onShare }: ShareDebugTranscriptButtonProps) => {
  const descriptionId = useId()
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const closeTimeoutRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current)
      }
    },
    [],
  )

  const revealDisabledReason = () => {
    setTooltipOpen(true)
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current)
    }
    closeTimeoutRef.current = window.setTimeout(() => {
      setTooltipOpen(false)
      closeTimeoutRef.current = null
    }, touchReasonDurationMs)
  }

  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={actionLabel}
          aria-disabled={disabledReason !== null}
          aria-describedby={disabledReason ? descriptionId : undefined}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon' }),
            mutedIconButtonClass,
            mobileHeaderControlFillClass,
            disabledReason && 'cursor-not-allowed opacity-50',
          )}
          onClick={disabledReason ? revealDisabledReason : onShare}
        >
          <Bug className="size-[var(--icon-size-default)]" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{disabledReason ?? actionLabel}</TooltipContent>
      {disabledReason && (
        <span id={descriptionId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </Tooltip>
  )
}
