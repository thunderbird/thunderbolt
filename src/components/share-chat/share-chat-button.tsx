/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLingui } from '@lingui/react/macro'
import { Share2 } from 'lucide-react'
import { useState } from 'react'
import { LazyShareChatDialog } from './lazy-share-chat-dialog'

type ShareChatButtonProps = {
  chatThreadId: string
  className?: string
}

/** Opens the share dialog for one chat. */
export const ShareChatButton = ({ chatThreadId, className }: ShareChatButtonProps) => {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={className}
            aria-label={t`Share chat`}
            onClick={() => setOpen(true)}
          >
            <Share2 className="size-[var(--icon-size-default)]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t`Share chat`}</TooltipContent>
      </Tooltip>
      <LazyShareChatDialog chatThreadId={chatThreadId} open={open} onOpenChange={setOpen} />
    </>
  )
}
