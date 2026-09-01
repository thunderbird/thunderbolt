/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useFormatters } from '@/i18n/use-formatters'
import { AlertTriangle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'

type ContextOverflowModalProps = {
  isOpen: boolean
  onClose: () => void
  onNewChat: () => void
  maxTokens?: number
}

/**
 * Modal shown when a message would exceed the model's context window
 */
export const ContextOverflowModal = ({ isOpen, onClose, onNewChat, maxTokens }: ContextOverflowModalProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const formattedMaxTokens = maxTokens ? formatters.compactNumber(maxTokens) : t`unknown`

  return (
    <AlertDialog open={isOpen} onOpenChange={() => onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600" />
            <AlertDialogTitle>
              <Trans>Context Window Exceeded</Trans>
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            <p>
              <Trans>Your message would exceed the model's {formattedMaxTokens}-token context window.</Trans>
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>
            <Trans>Close</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onNewChat()
              onClose()
            }}
          >
            <Trans>New Chat</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
