/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

type CopyableCommandProps = {
  /** The shell command to display and copy. */
  command: string
}

/** A monospace command line with a copy-to-clipboard affordance. The copied
 *  state is owned by `useCopyToClipboard` (timer-with-cleanup), so the button
 *  flips to a check for a couple of seconds after a successful copy. */
export const CopyableCommand = ({ command }: CopyableCommandProps) => {
  const { copy, isCopied } = useCopyToClipboard()

  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 min-w-0 rounded-md border border-border bg-muted px-3 py-2 font-mono text-[length:var(--font-size-xs)] break-all">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={isCopied ? 'Copied' : 'Copy command'}
        onClick={() => copy(command)}
      >
        {isCopied ? <Check className="text-green-600" /> : <Copy />}
      </Button>
    </div>
  )
}
