/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

type CopyableCommandProps = {
  /** The shell command to display and copy. */
  command: string
  /** Stable suffix for the copy button's testid, e.g. `install`. */
  testId?: string
}

/** A monospaced code block with a copy-to-clipboard button. Used by the bridge
 *  connect dialog to surface the install / run commands for the user to paste
 *  into a terminal. The command wraps so long lines stay readable. */
export const CopyableCommand = ({ command, testId }: CopyableCommandProps) => {
  const { copy, isCopied } = useCopyToClipboard()

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-2">
      <code className="flex-1 min-w-0 break-all font-mono text-[length:var(--font-size-xs)] leading-relaxed">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 shrink-0 p-0 hover:bg-muted"
        onClick={() => copy(command)}
        aria-label={isCopied ? 'Copied' : 'Copy command'}
        data-testid={testId ? `copyable-command-copy-${testId}` : 'copyable-command-copy'}
      >
        {isCopied ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  )
}
